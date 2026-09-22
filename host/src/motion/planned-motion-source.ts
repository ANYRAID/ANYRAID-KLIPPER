import {performance} from 'node:perf_hooks';
import type {Move} from './lookahead.ts';
import type {TrapQueue} from './trap-queue.ts';
import {CoordinatedMotionDrain} from './coordinated-drain.ts';
/** Append can retry after flushing; terminal drain errors still stop devices. */
export class MotionSourceCapacityError extends RangeError {}
export interface PlannedQueue {queue:TrapQueue;extrusionAxis?:number}
/** Exclusive source writer for coordinated XYZ and extra-axis trap queues.
 * Inputs must already have passed kinematic/extrusion admission and lookahead.
 * The owner must schedule print time ahead of every participating MCU; this
 * class does not infer a safe print time from host wall time. */
export class PlannedMotionSource {
 readonly #routes:readonly PlannedQueue[];readonly #drain:CoordinatedMotionDrain;
 readonly #ends:Float64Array;#head=0;#count=0;#seeded=false;
 #position:number[];#time:number;#retired=false;#busy=false;#paused=false;#failed=false;#fault:unknown;
 constructor(routes:readonly PlannedQueue[],drain:CoordinatedMotionDrain,startTime:number,position:readonly number[],maxBufferedMoves=65536){
  if(!Number.isSafeInteger(maxBufferedMoves)||maxBufferedMoves<1||maxBufferedMoves>65536)throw new RangeError('Invalid source capacity');
  this.#ends=new Float64Array(maxBufferedMoves);
  if(!Number.isFinite(startTime)||startTime<0||startTime>=1e15||!Array.isArray(position)||position.length<4||!position.every(Number.isFinite)||!drain.usesQueues(routes.map(r=>r.queue)))throw new RangeError('Invalid planned source ownership or baseline');
  const axes=new Set<number>();let xyz=0;
  for(const r of routes){if(r.extrusionAxis===undefined)xyz++;else if(!Number.isInteger(r.extrusionAxis)||r.extrusionAxis<3||r.extrusionAxis>=position.length||axes.has(r.extrusionAxis))throw new RangeError('Invalid planned source extrusion route');else axes.add(r.extrusionAxis);}
  if(xyz!==1||axes.size!==position.length-3)throw new RangeError('Planned source requires XYZ and every extra axis');
  this.#routes=routes.map(r=>({...r}));this.#drain=drain;this.#time=startTime;this.#position=[...position];
 }
 get status(){return {retired:this.#retired,bufferedMoves:this.#count,availableMoves:this.#ends.length-this.#count,sourceTime:this.#time,position:[...this.#position],busy:this.#busy,paused:this.#paused,failed:this.#failed,fault:this.#fault};}
 #release():void{const cutoff=this.#drain.finalizedSourceTime;while(this.#count&&this.#ends[this.#head]<=cutoff){this.#head=(this.#head+1)%this.#ends.length;this.#count--;}}
 #capacity(moves:readonly Move[]):void{if(Array.isArray(moves)&&moves.length>this.#ends.length-this.#count)throw new MotionSourceCapacityError('Planned source capacity exceeded; flush before retrying');}
 #check():void{if(this.#retired)throw new Error('Planned source producer retired');if(this.#failed)throw new Error('Planned motion source failed',{cause:this.#fault});if(this.#busy)throw new Error('Planned motion source busy');}
 async #stop(error:unknown):Promise<void>{this.#failed=true;this.#fault??=error;try{await this.#drain.stop(error);}catch(stop){this.#fault=new AggregateError([error,stop],'Planned source and stop failed');} }
 #validate(moves:readonly Move[],storeEnds:boolean,limit=65536){
  if(!Array.isArray(moves)||moves.length>limit)throw new RangeError('Invalid planned source batch');
  if(this.#paused&&moves.length)throw new Error('Resume planned motion with a fresh print time first');
  let position=this.#position,time=this.#time,staged=0;
  // Validate the entire batch before any queue mutation. Input objects are used
  // synchronously, so callers cannot mutate them between queue appends.
  for(const m of moves as readonly Move[]){const p=m.profile;if(!p||m.startPos.length!==position.length||m.endPos.length!==position.length||m.startPos.some((v,i)=>v!==position[i])||!m.endPos.every(Number.isFinite)||![p.accelT,p.cruiseT,p.decelT,p.startV,p.cruiseV,p.endV,m.accel].every(v=>Number.isFinite(v)&&v>=0)||p.cruiseV===0||m.accel===0)throw new RangeError('Invalid or discontinuous planned motion');time=((time+p.accelT)+p.cruiseT)+p.decelT;if(!Number.isFinite(time)||time>=1e15)throw new RangeError('Planned source time overflow');position=m.endPos;if(storeEnds)this.#ends[(this.#head+this.#count+staged++)%this.#ends.length]=time;}
  return {position,time};
 }
 #seed():void{
  if(this.#seeded)return;const from=this.#drain.generatedTime;
  if(!Number.isFinite(from)||from>this.#time)throw new RangeError('Invalid source generation baseline');
  if(from<this.#time)for(const r of this.#routes){const p=r.extrusionAxis===undefined?this.#position.slice(0,3):[this.#position[r.extrusionAxis],0,0];r.queue.appendRaw(new Float64Array([from,0,this.#time-from,0,...p,0,0,0,0,0,0]));}
  this.#seeded=true;
 }
 #append(moves:readonly Move[]):void{
  const {position,time}=this.#validate(moves,true);this.#seed();
  for(const r of this.#routes){const end=r.queue.appendPlanned(moves,this.#time,r.extrusionAxis,true);if(end!==time)throw new Error('Planned queue timelines differ');}
  this.#position=[...position];this.#time=time;this.#count+=moves.length;
 }
 /** Transfer an unused generation to a privileged producer. This only fences
  * this source writer; the new owner must still arm/stop the physical MCU. */
 retireProducer():void{this.#check();if(this.#count||this.#paused||this.#seeded)throw new Error('Only an unused planned source may transfer');this.#retired=true;}
 /** Append earlier lookahead flushes without losing the final drain endpoint. */
 append(moves:readonly Move[]):void{this.#check();this.#capacity(moves);try{this.#append(moves);}catch(error){void this.#stop(error);throw error;}}
 /** Call after a successful drain, before producing subsequent motion. The
  * supplied time must include the scheduler's current MCU lead requirement. */
 resumeAt(printTime:number):void{this.#check();if(!this.#paused||!Number.isFinite(printTime)||printTime<this.#time||printTime>=1e15)throw new RangeError('Invalid planned source resume time');this.#time=printTime;this.#paused=false;}
 /** Rolling commit; preserves the tail needed by shaping/pressure advance.
  * Success means transport acceptance, not completed physical movement. */
 async flush(signal:AbortSignal,timeoutMs=30000,clearHistoryTime=0):Promise<boolean>{
  this.#check();signal.throwIfAborted();if(this.#paused)throw new Error('Planned source is paused');this.#busy=true;
  try{this.#seed();const result=await this.#drain.advanceSource(this.#time,signal,timeoutMs,clearHistoryTime);this.#release();return result;}
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
    const owned=moves.map(m=>Object.assign(Object.create(Object.getPrototypeOf(m)),m,{startPos:[...m.startPos],endPos:[...m.endPos],axesD:[...m.axesD],axesR:[...m.axesR],profile:m.profile?{...m.profile}:undefined})) as Move[];
    this.#validate(owned,false,100000);remaining();
    let offset=0;
    while(offset<owned.length){
     const available=this.#ends.length-this.#count;
     if(!available){await this.#drain.advanceSource(this.#time,signal,remaining());this.#release();remaining();if(this.#count===this.#ends.length)throw new MotionSourceCapacityError('Source capacity cannot cover the solver lookahead window');continue;}
     const count=Math.min(available,owned.length-offset);this.#append(owned.slice(offset,offset+count));offset+=count;remaining();
    }
   }
   const positions=new Map<TrapQueue,readonly [number,number,number]>(this.#routes.map(r=>[r.queue,r.extrusionAxis===undefined?[this.#position[0],this.#position[1],this.#position[2]]:[this.#position[r.extrusionAxis],0,0]]));
   const result=await this.#drain.drain(this.#time,positions,signal,remaining());remaining();this.#time=result.sourceUntil;this.#paused=true;this.#release();
  }catch(error){await this.#stop(error);throw this.#fault;}
  finally{this.#busy=false;}
 }
}
