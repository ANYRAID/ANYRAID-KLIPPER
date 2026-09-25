import {validateDwell} from './dwell.ts';
import {performance} from 'node:perf_hooks';
import {Move} from './lookahead.ts';
import type {TrapQueue} from './trap-queue.ts';
import {CoordinatedMotionDrain} from './coordinated-drain.ts';
import {planPathStop,type PathStop} from './path-stop.ts';
import {copyEndMarkers,validateEndMarkers} from './boundary-markers.ts';
import {stationaryRows} from './stationary.ts';
import {copyPressureBoundaries,validatePressureBoundaries,pressureBoundarySchedule,type PressureBoundary} from './pressure-boundaries.ts';
type MotionSnapshot=Omit<Move,'limitSpeed'|'limitNextJunctionSpeed'|'calcJunction'|'setJunction'>;
// Snapshot data on the hot path; hydrate planner methods only when braking.
const ownMove=(m:Move):MotionSnapshot=>({
 dwellSeconds:m.dwellSeconds,endMarkers:copyEndMarkers(m.endMarkers),pressureBoundaries:copyPressureBoundaries(m.pressureBoundaries),
 limits:{...m.limits,extraAxes:m.limits.extraAxes?[...m.limits.extraAxes]:undefined},startPos:[...m.startPos],endPos:[...m.endPos],axesD:[...m.axesD],axesR:[...m.axesR],
 distance:m.distance,isKinematic:m.isKinematic,junctionDeviation:m.junctionDeviation,accel:m.accel,minMoveT:m.minMoveT,maxStartV2:m.maxStartV2,maxCruiseV2:m.maxCruiseV2,deltaV2:m.deltaV2,nextJunctionV2:m.nextJunctionV2,maxMcrStartV2:m.maxMcrStartV2,mcrDeltaV2:m.mcrDeltaV2,profile:m.profile?{...m.profile}:undefined,
});
/** Append can retry after flushing; terminal drain errors still stop devices. */
export class MotionSourceCapacityError extends RangeError {}
export interface PlannedQueue {queue:TrapQueue;extrusionAxis?:number}
export interface SourceBoundaryOutput {
 deliver(boundaries:readonly {id:number;time:number}[],horizon:number,signal:AbortSignal):Promise<void>;
 invalidateAfter(time:number):void;
 /** Finish already scheduled tails and await the output MCU clock. */
 settle(signal:AbortSignal):Promise<void>;
 stop(cause:unknown):Promise<void>;
}
/** Exclusive source writer for coordinated XYZ and extra-axis trap queues.
 * Inputs must already have passed kinematic/extrusion admission and lookahead.
 * The owner must schedule print time ahead of every participating MCU; this
 * class does not infer a safe print time from host wall time. */
export class PlannedMotionSource {
 readonly #routes:readonly PlannedQueue[];readonly #drain:CoordinatedMotionDrain;
 readonly #ends:Float64Array;#head=0;#count=0;#seeded=false;#idleFrom:number|undefined;
 readonly #starts:Float64Array;readonly #moves:(MotionSnapshot|undefined)[];#braking=false;
 #position:number[];#time:number;#endVelocity=0;#dwellEnd=false;#retired=false;#busy=false;#paused=false;#failed=false;#fault:unknown;
 #idlePressure:readonly PressureBoundary[]=[];
 #idleMarkers:readonly number[]=[];#stationary:{id:number;time:number}[]=[];
 #output:SourceBoundaryOutput|undefined;#deliver:((horizon:number,signal:AbortSignal)=>Promise<void>)|undefined;#deliverRolling:((horizon:number,signal:AbortSignal)=>Promise<void>)|undefined;#deliverFinal:((horizon:number,signal:AbortSignal)=>Promise<void>)|undefined;
 constructor(routes:readonly PlannedQueue[],drain:CoordinatedMotionDrain,startTime:number,position:readonly number[],maxBufferedMoves=65536,output?:SourceBoundaryOutput){
  if(!Number.isSafeInteger(maxBufferedMoves)||maxBufferedMoves<1||maxBufferedMoves>65536)throw new RangeError('Invalid source capacity');
  this.#ends=new Float64Array(maxBufferedMoves);
  this.#starts=new Float64Array(maxBufferedMoves);this.#moves=new Array(maxBufferedMoves);
  if(!Number.isFinite(startTime)||startTime<0||startTime>=1e15||!Array.isArray(position)||position.length<4||!position.every(Number.isFinite)||!drain.usesQueues(routes.map(r=>r.queue)))throw new RangeError('Invalid planned source ownership or baseline');
  const axes=new Set<number>();let xyz=0;
  for(const r of routes){if(r.extrusionAxis===undefined)xyz++;else if(!Number.isInteger(r.extrusionAxis)||r.extrusionAxis<3||r.extrusionAxis>=position.length||axes.has(r.extrusionAxis))throw new RangeError('Invalid planned source extrusion route');else axes.add(r.extrusionAxis);}
  if(xyz!==1||axes.size!==position.length-3)throw new RangeError('Planned source requires XYZ and every extra axis');
  this.#routes=routes.map(r=>({...r}));this.#drain=drain;this.#time=startTime;this.#position=[...position];
  this.#output=output;if(output){this.#deliver=(horizon,signal)=>output.deliver(this.#schedule(),horizon,signal);
   // A one-slot output FIFO may withhold ACK until its preceding MCU tick.
   // Keep 100 ms of already committed motion beyond rolling output delivery;
   // otherwise dense output ACKs can consume all motion lead. Resolve the full
   // snapshot now so source retirement cannot lose the unsent endpoint suffix.
   this.#deliverRolling=(horizon,signal)=>this.#deliver!(Math.max(0,horizon-.1),signal);
   this.#deliverFinal=async(horizon,signal)=>{await this.#deliver!(horizon,signal);signal.throwIfAborted();await output.settle(signal);};
  }
 }
 get status(){return {seeded:this.#seeded,retired:this.#retired,bufferedMoves:this.#count,availableMoves:this.#ends.length-this.#count,pendingBoundaries:this.#idleMarkers.length+this.#stationary.length+this.#idlePressure.length,sourceTime:this.#time,position:[...this.#position],busy:this.#busy,paused:this.#paused,braking:this.#braking,failed:this.#failed,fault:this.#fault};}
 /** An idle request is anchored only when fresh start/resume time is seeded.
  * It never fabricates a zero-length Move or grants a motion permission. */
 markBoundary(id:number):void{
  this.#check();if(!this.#output||this.#braking)throw new Error('Source boundary output unavailable');
  if(this.#count){const m=this.#moves[(this.#head+this.#count-1)%this.#ends.length]!;m.endMarkers=copyEndMarkers([...m.endMarkers??[],id]);}
  else{if(this.#seeded&&!this.#paused)throw new Error('Stationary boundary requires an unused or drained source');this.#idleMarkers=copyEndMarkers([...this.#idleMarkers,id])!;}
 }
 /** Fixed-window request at the next explicitly seeded stationary boundary.
  * An active or buffered path must use its own geometric endpoint instead.
  * Repeated requests for one emitter coalesce before any native scheduling. */
 markIdlePressureBoundary(change:PressureBoundary):void{
  this.#check();validatePressureBoundaries([change]);
  if(this.#count||this.#braking||this.#seeded&&!this.#paused&&this.#idleFrom===undefined)throw new Error('Idle pressure requires an unused or drained source');
  this.#idlePressure=copyPressureBoundaries([...this.#idlePressure.filter(c=>c.stepper!==change.stepper),change])!;
 }
 /** Release only a completely quiescent output lane. The generation owner
  * must fence admission and authorize the receiving MCU/calibration itself. */
 detachBoundaryOutput():void{
  this.#check();if(!this.#output||this.#count||this.#idleMarkers.length||this.#stationary.length||this.#braking||this.#seeded&&!this.#paused)throw new Error('Boundary output transfer requires an unused or drained source');
  this.#output=undefined;this.#deliver=this.#deliverRolling=this.#deliverFinal=undefined;
 }
 /** Current buffered plan only. Read before release; braking/rebase invalidates
  * old times. This snapshot neither dispatches nor acknowledges output events. */
 boundarySchedule():readonly {id:number;time:number}[]{
  this.#check();return this.#schedule();
 }
 #schedule():readonly {id:number;time:number}[]{
  const result:{id:number;time:number}[]=this.#stationary.map(b=>Object.freeze({...b}));
  for(let i=0;i<this.#count;i++){const slot=(this.#head+i)%this.#ends.length;for(const id of this.#moves[slot]?.endMarkers??[])result.push(Object.freeze({id,time:this.#ends[slot]}));}return Object.freeze(result);
 }
 #release():void{const cutoff=this.#drain.finalizedSourceTime;if(this.#stationary.length)this.#stationary=this.#stationary.filter(b=>b.time>cutoff);while(this.#count&&this.#ends[this.#head]<=cutoff){this.#moves[this.#head]=undefined;this.#head=(this.#head+1)%this.#ends.length;this.#count--;}}
 #capacity(moves:readonly Move[]):void{if(Array.isArray(moves)&&moves.length>this.#ends.length-this.#count)throw new MotionSourceCapacityError('Planned source capacity exceeded; flush before retrying');}
 #check():void{if(this.#retired)throw new Error('Planned source producer retired');if(this.#failed)throw new Error('Planned motion source failed',{cause:this.#fault});if(this.#busy)throw new Error('Planned motion source busy');}
 async #stop(error:unknown):Promise<void>{this.#failed=true;this.#fault??=error;this.#moves.fill(undefined);this.#idleMarkers=[];this.#stationary=[];this.#idlePressure=[];const jobs:Promise<void>[]=[];for(const stop of [()=>this.#drain.stop(error),...this.#output?[()=>this.#output!.stop(error)]:[]])try{jobs.push(stop());}catch(cause){jobs.push(Promise.reject(cause));}const results=await Promise.allSettled(jobs),errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)this.#fault=new AggregateError([error,...errors],'Planned source and stop failed');}
 #validate(moves:readonly Move[],storeEnds:boolean,limit=65536){
  if(!Array.isArray(moves)||moves.length>limit)throw new RangeError('Invalid planned source batch');
  if(this.#paused&&(moves.length||this.#idleMarkers.length||this.#idlePressure.length))throw new Error('Resume planned motion with a fresh print time first');
  if(this.#braking&&moves.length)throw new Error('Drain the braking source before admitting more motion');
  let position=this.#position,time=this.#time,staged=0,velocity=this.#endVelocity,afterDwell=this.#dwellEnd;
  // Validate the entire batch before any queue mutation. Input objects are used
  // synchronously, so callers cannot mutate them between queue appends.
  for(const m of moves as readonly Move[]){validateEndMarkers(m.endMarkers);validatePressureBoundaries(m.pressureBoundaries);const p=m.profile;if(m.dwellSeconds!==undefined){validateDwell(m);if(velocity!==0)throw new RangeError('Dwell must begin at rest');}if(afterDwell&&p?.startV!==0)throw new RangeError('Motion after dwell must start at rest');if(!p||m.startPos.length!==position.length||m.endPos.length!==position.length||m.startPos.some((v,i)=>v!==position[i])||!m.endPos.every(Number.isFinite)||![p.accelT,p.cruiseT,p.decelT,p.startV,p.cruiseV,p.endV,m.accel].every(v=>Number.isFinite(v)&&v>=0)||p.cruiseV===0&&m.dwellSeconds===undefined||m.accel===0)throw new RangeError('Invalid or discontinuous planned motion');const prior=time;time=((time+p.accelT)+p.cruiseT)+p.decelT;if(m.dwellSeconds!==undefined&&time<=prior)throw new RangeError('Unrepresentable dwell endpoint');velocity=p.endV;afterDwell=m.dwellSeconds!==undefined;if(!Number.isFinite(time)||time>=1e15)throw new RangeError('Planned source time overflow');position=m.endPos;if(storeEnds)this.#ends[(this.#head+this.#count+staged++)%this.#ends.length]=time;}
  return {position,time};
 }
 #seed():void{
  const from=this.#seeded?this.#idleFrom:this.#drain.generatedTime;if(from===undefined)return;
  if(!Number.isFinite(from)||from>this.#time)throw new RangeError('Invalid source generation baseline');
  if(from<this.#time)for(const r of this.#routes){const p=r.extrusionAxis===undefined?this.#position.slice(0,3):[this.#position[r.extrusionAxis],0,0];r.queue.appendRaw(stationaryRows(from,this.#time,p));}
  if(this.#idleMarkers.length){this.#stationary.push(...this.#idleMarkers.map(id=>({id,time:this.#time})));this.#idleMarkers=[];}
  if(this.#idlePressure.length){this.#drain.schedulePressureBoundaries(this.#idlePressure.map(c=>({...c,time:this.#time})));this.#idlePressure=[];}
  this.#seeded=true;this.#idleFrom=undefined;
 }
 #append(moves:readonly Move[]):void{
  const {position,time}=this.#validate(moves,true),owned=moves.map(ownMove),pressure=moves.some(m=>m.pressureBoundaries?.length)?pressureBoundarySchedule(moves,this.#time):[];this.#seed();
  for(const r of this.#routes){const end=r.queue.appendPlanned(moves,this.#time,r.extrusionAxis,true);if(end!==time)throw new Error('Planned queue timelines differ');}
  if(pressure.length)this.#drain.schedulePressureBoundaries(pressure);
  let start=this.#time;for(let i=0;i<owned.length;i++){const slot=(this.#head+this.#count+i)%this.#ends.length;this.#moves[slot]=owned[i];this.#starts[slot]=start;start=this.#ends[slot];}
  this.#position=[...position];this.#time=time;this.#count+=moves.length;if(moves.length){this.#endVelocity=moves.at(-1)!.profile!.endV;this.#dwellEnd=moves.at(-1)!.dwellSeconds!==undefined;}
 }
 /** Transfer an unused generation to a privileged producer. This only fences
  * this source writer; the new owner must still arm/stop the physical MCU. */
 retireProducer():void{this.#check();if(this.#output)throw new Error('Boundary output ownership must transfer with its source');if(this.#count||this.#paused||this.#seeded||this.#idlePressure.length)throw new Error('Only an unused planned source without pending pressure may transfer');this.#retired=true;}
 /** Validate a complete owned stream before any prefix is submitted. */
 validateBatch(moves:readonly Move[]):void{this.#check();this.#validate(moves,false,100000);}
 /** Replace the owned suffix with a controlled brake. Completion only changes
  * source queues; caller must pace/flush and drain before claiming paused. */
 async brakeAt(printTime:number,signal:AbortSignal,timeoutMs=30000):Promise<PathStop>{
  this.#check();signal.throwIfAborted();this.#busy=true;
  try{
   if(this.#paused||this.#braking||!this.#seeded||!Number.isFinite(printTime)||printTime>=this.#time)throw new RangeError('Invalid braking source state or horizon');
   let offset=0;while(offset<this.#count&&this.#ends[(this.#head+offset)%this.#ends.length]<=printTime)offset++;
   if(offset===this.#count)throw new RangeError('Braking anchor is outside owned path');
   const slot=(this.#head+offset)%this.#ends.length,start=this.#starts[slot];if(printTime<start)throw new RangeError('Braking anchor precedes owned path');
   const path:Move[]=[];for(let i=offset;i<this.#count;i++)path.push(Object.setPrototypeOf(this.#moves[(this.#head+i)%this.#ends.length]!,Move.prototype));
   const result=planPathStop(path,printTime-start),owned=result.brake.map(m=>Object.setPrototypeOf(ownMove(m),Move.prototype) as Move);
   const end=await this.#drain.replaceFuture(printTime,owned,this.#routes,result.position,signal,timeoutMs,this.#output?async s=>{await this.#deliverRolling!(this.#drain.committedTime,s);s.throwIfAborted();this.#output!.invalidateAfter(printTime);}:undefined);signal.throwIfAborted();
   this.#moves.fill(undefined);this.#head=0;this.#count=owned.length;let time=printTime;
   for(let i=0;i<owned.length;i++){const m=owned[i],p=m.profile!;this.#starts[i]=time;time=((time+p.accelT)+p.cruiseT)+p.decelT;this.#ends[i]=time;this.#moves[i]=m;}
   this.#position=[...result.position];this.#time=end;this.#endVelocity=0;this.#dwellEnd=false;this.#braking=true;return result;
  }catch(error){await this.#stop(error);throw this.#fault;}finally{this.#busy=false;}
 }
 /** Append earlier lookahead flushes without losing the final drain endpoint. */
 append(moves:readonly Move[]):void{this.#check();this.#capacity(moves);try{this.#append(moves);}catch(error){void this.#stop(error);throw error;}}
 /** Delay an unused source without changing its coordinates or MCU mapping.
  * Native generation covers the intervening stationary startup interval. */
 startAt(printTime:number):void{this.#check();if(this.#seeded||this.#count||this.#paused||!Number.isFinite(printTime)||printTime<this.#time||printTime>=1e15)throw new RangeError('Invalid unused source start time');this.#time=printTime;}
 /** Call after a successful drain, before producing subsequent motion. The
  * supplied time must include the scheduler's current MCU lead requirement. */
 resumeAt(printTime:number):void{this.#check();if(!this.#paused||!Number.isFinite(printTime)||printTime<this.#time||printTime>=1e15)throw new RangeError('Invalid planned source resume time');this.#idleFrom=this.#time;this.#time=printTime;this.#paused=false;}
 /** Consume known stationary startup/resume coverage in one native transaction.
  * A source that already owns active motion is never eligible for this path.
  * Optionally retain up to 10 ms of generated headroom for a synchronous
  * calibration; all stationary source data remains available to the solver. */
 async prepareIdle(signal:AbortSignal,timeoutMs=30000,calibrationReserve=0):Promise<boolean>{
  this.#check();signal.throwIfAborted();
  if(!Number.isFinite(calibrationReserve)||calibrationReserve<0||calibrationReserve>.01||this.#time-calibrationReserve<this.#drain.generatedTime)throw new RangeError('Invalid idle calibration reserve');
  if(this.#seeded&&this.#idleFrom===undefined)return false;
  if(this.#count||this.#paused)throw new Error('Idle preparation requires an unused or resumed source');this.#busy=true;
  try{this.#seed();return await this.#drain.advanceIdleSource(this.#time-calibrationReserve,signal,timeoutMs);}
  catch(error){await this.#stop(error);throw this.#fault;}finally{this.#busy=false;}
 }
 /** Rolling commit; preserves the tail needed by shaping/pressure advance.
  * Success means transport acceptance, not completed physical movement. */
 async flush(signal:AbortSignal,timeoutMs=30000,clearHistoryTime=0):Promise<boolean>{
  return this.flushThrough(this.#time,signal,timeoutMs,clearHistoryTime);
 }
 /** Commit only a prefix of already appended source, preserving native filter tails. */
 async flushThrough(sourceUntil:number,signal:AbortSignal,timeoutMs=30000,clearHistoryTime=0):Promise<boolean>{
  this.#check();signal.throwIfAborted();if(this.#paused)throw new Error('Planned source is paused');
  if(!Number.isFinite(sourceUntil)||sourceUntil<this.#drain.generatedTime||sourceUntil>this.#time)throw new RangeError('Invalid planned source commit horizon');this.#busy=true;
  try{this.#seed();const result=await this.#drain.advanceSource(sourceUntil,signal,timeoutMs,clearHistoryTime,this.#deliverRolling);this.#release();return result;}
  catch(error){await this.#stop(error);throw this.#fault;}finally{this.#busy=false;}
 }
 async drain(moves:readonly Move[],signal:AbortSignal,timeoutMs=30000):Promise<void>{
  this.#check();signal.throwIfAborted();this.#busy=true;
  try{
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new RangeError('Invalid motion drain timeout');
   const deadline=performance.now()+timeoutMs,remaining=()=>{signal.throwIfAborted();const ms=Math.ceil(deadline-performance.now());if(ms<=0)throw new Error('Planned source drain timed out');return ms;};
   if(!Array.isArray(moves)||moves.length>100000)throw new RangeError('Invalid planned drain batch');
   if(moves.length<=this.#ends.length-this.#count)this.#append(moves);
   else {
    // Snapshot before the first await. Later caller edits cannot change a suffix
    // after its prefix has already reached a native queue or device.
    const owned=moves.map(m=>Object.setPrototypeOf(ownMove(m),Object.getPrototypeOf(m))) as Move[];
    this.#validate(owned,false,100000);remaining();
    let offset=0;
    while(offset<owned.length){
     const available=this.#ends.length-this.#count;
     if(!available){await this.#drain.advanceSource(this.#time,signal,remaining(),0,this.#deliverRolling);this.#release();remaining();if(this.#count===this.#ends.length)throw new MotionSourceCapacityError('Source capacity cannot cover the solver lookahead window');continue;}
     const count=Math.min(available,owned.length-offset);this.#append(owned.slice(offset,offset+count));offset+=count;remaining();
    }
   }
   const positions=new Map<TrapQueue,readonly [number,number,number]>(this.#routes.map(r=>[r.queue,r.extrusionAxis===undefined?[this.#position[0],this.#position[1],this.#position[2]]:[this.#position[r.extrusionAxis],0,0]]));
   const result=await this.#drain.drain(this.#time,positions,signal,remaining(),this.#deliverFinal);remaining();this.#time=result.sourceUntil;this.#paused=true;this.#endVelocity=0;this.#dwellEnd=false;this.#braking=false;this.#release();
  }catch(error){await this.#stop(error);throw this.#fault;}
  finally{this.#busy=false;}
 }
}
