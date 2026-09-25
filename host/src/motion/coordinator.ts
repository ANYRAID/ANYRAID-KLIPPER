import {MotionRetiredError,observeRetirement} from './retired.ts';
import {PrintClockTimeline,type ClockHistoryLease} from '../timing/print-clock-timeline.ts';
import type {StepCompressor,CompressedSteps} from './step-compressor.ts';
import type {TrapQueue} from './trap-queue.ts';
import type {Move} from './lookahead.ts';
import {pressureBoundarySchedule,type TimedPressureBoundary} from './pressure-boundaries.ts';
import {stationaryRows} from './stationary.ts';
export interface MotionBinding {id:string;queue:TrapQueue;stepper:StepCompressor}
export interface MotionOutput extends CompressedSteps {id:string}
export interface MotionBatch {sequence:number;from:number;until:number;generatedUntil?:number;outputs:readonly MotionOutput[]}
export interface MotionSink {
 /** Preserve each output's packet order, route to its MCU, and retain homing history.
  * Resolve after accepting the entire batch. Rejection may mean partial acceptance. */
 commit(batch:Readonly<MotionBatch>):Promise<void>;
 /** Fence in-flight/future commits, cancel queued motion and stop all affected devices. */
 stop(cause:unknown):Promise<void>;
 /** Synchronously fence commits and await accepted delivery plus active work. */
 retire?(signal:AbortSignal):Promise<void>;
}
/** Single-use coordination of native step generation. Does not implement the MCU
 * move-slot scheduler, clock calibration, serial transport or hardware watchdog. */
export class MotionCoordinator {
 #guards:readonly {assertActive():void}[];
 #historyClocks:ReadonlyMap<string,PrintClockTimeline>|undefined;
 #historyLeases=new Map<PrintClockTimeline,{lease:ClockHistoryLease;tick:bigint}>();
 #releaseHistory(){for(const {lease} of this.#historyLeases.values())lease.release();this.#historyLeases.clear();}
 #bindings:readonly MotionBinding[];#sink:MotionSink;#busy=false;#bounded=false;#fault:unknown;#failed=false;
 #stopPromise:Promise<void>|undefined;
 #retired=false;#retirementComplete=false;#retirement:Promise<void>|undefined;#idle=Promise.resolve();#resolveIdle:(()=>void)|undefined;
 #beginWork(){if(!this.#busy&&!this.#bounded)this.#idle=new Promise(resolve=>{this.#resolveIdle=resolve;});}
 #endWork(){if(!this.#busy&&!this.#bounded){this.#resolveIdle?.();this.#resolveIdle=undefined;}}
 #finalizedSourceTime=0;#generated:number;#committed:number;#baseline:number;#sequence=0;#maxBytes:number;
 constructor(bindings:readonly MotionBinding[],sink:MotionSink,maxBatchBytes=16*1024*1024,initialCommittedTime=0,clockHealth:readonly {assertActive():void}[]=[],historyClocks?:ReadonlyMap<string,PrintClockTimeline>){
  if(!bindings.length||bindings.length>128||!Number.isSafeInteger(maxBatchBytes)||maxBatchBytes<1)throw new RangeError('Invalid motion coordinator limits');
  const ids=new Set<string>(),steppers=new Set<StepCompressor>();
  for(const b of bindings){
   if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(b.id)||ids.has(b.id)||steppers.has(b.stepper)||!b.queue.ownsStepper(b.stepper))throw new Error('Invalid or duplicate motion binding');
   ids.add(b.id);steppers.add(b.stepper);
  }
  if(!Number.isFinite(initialCommittedTime)||initialCommittedTime<0||initialCommittedTime>=1e15)throw new RangeError('Invalid initial committed time');
  const time=initialCommittedTime;
  if(bindings.some(b=>b.stepper.generatedTime!==time))throw new Error('Steppers must match the declared committed baseline');
  this.#guards=[...clockHealth];
  this.#bindings=bindings.map(b=>({...b}));this.#sink=sink;this.#generated=this.#committed=this.#baseline=time;this.#maxBytes=maxBatchBytes;
  if(historyClocks){
   if(historyClocks.size!==bindings.length||bindings.some(b=>{const clock=historyClocks.get(b.id);if(!(clock instanceof PrintClockTimeline))return true;const a=clock.status.calibration,c=b.stepper.calibration;return a.offset!==c.offset||a.frequency!==c.frequency;}))throw new Error('Motion history clocks must cover matching emitters');
   this.#historyClocks=new Map(historyClocks);
   try{for(const clock of new Set(historyClocks.values())){const tick=clock.status.fromClock;this.#historyLeases.set(clock,{lease:clock.retain(tick),tick});}}catch(error){this.#releaseHistory();throw error;}
  }
 }
 /** Retain 30 seconds behind the slowest observed emitter, plus 1 ms margin.
  * Observations must come from the same MCU routes and current generation. */
 historyCutoff(clocks:Readonly<Record<string,bigint>>):number{
  if(this.#retired)throw new MotionRetiredError();if(this.#failed)throw new Error('Motion coordinator is faulted');const entries=Object.entries(clocks);
  if(entries.length!==this.#bindings.length||this.#bindings.some(b=>!Object.hasOwn(clocks,b.id)))throw new RangeError('History clocks must cover all emitters');
  for(const guard of this.#guards)guard.assertActive();let time=Infinity;
  for(const b of this.#bindings)time=Math.min(time,(this.#historyClocks?.get(b.id)??b.stepper).printTimeAtClock(clocks[b.id]));
  const boundary=time-30,cutoff=Math.max(0,boundary-.001);if(cutoff>0&&cutoff>=boundary)throw new RangeError('History margin below print-time resolution');
  const retainUntil=Math.min(cutoff,this.#generated);
  for(const [clock,retained] of this.#historyLeases){if(retainUntil<=clock.printTimeAtClock(retained.tick))continue;const mapped=clock.clockAt(retainUntil),tick=clock.printTimeAtClock(mapped)>retainUntil?mapped-1n:mapped;retained.lease.advance(tick);retained.tick=tick;}
  return cutoff;
 }
 /** Common lower bound actually finalized in every source queue. */
 get finalizedSourceTime():number{return this.#finalizedSourceTime;}
 usesQueues(queues:readonly TrapQueue[]):boolean{const owned=new Set(this.#bindings.map(b=>b.queue));return queues.length===owned.size&&new Set(queues).size===owned.size&&queues.every(q=>owned.has(q));}
 usesSink(sink:MotionSink):boolean{return this.#sink===sink;}
 /** Change scan windows only at the fully submitted generation frontier.
  * Source owners must supply stationary coverage for both old/new windows;
  * transport acceptance is required here, physical MCU completion is not. */
 reconfigurePressureWindows(time:number,changes:readonly {stepper:string;advance:number;smoothTime:number}[]):void{
  if(this.#retired||this.#failed||this.#busy||this.#bounded||time!==this.#generated||this.#committed!==this.#generated)throw new Error('Pressure window change requires a submitted generation boundary');
  this.#beginWork();this.#busy=true;
  try{
   for(const guard of this.#guards)guard.assertActive();
   if(!Array.isArray(changes)||!changes.length||changes.length>128||new Set(changes.map(c=>c.stepper)).size!==changes.length)throw new RangeError('Invalid pressure window group');
   const staged=changes.map(c=>{const b=this.#bindings.find(b=>b.id===c.stepper);if(!b||b.stepper.generatedTime!==time)throw new RangeError('Invalid pressure window emitter');return {stepper:b.stepper,advance:c.advance,smoothTime:c.smoothTime};});
   for(const c of staged)c.stepper.validatePressureAdvanceWindow(c.advance,c.smoothTime);
   for(const c of staged)c.stepper.reconfigurePressureAdvance(c.advance,c.smoothTime);
  }catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  finally{this.#busy=false;this.#endWork();}
 }
 /** The source owner may revise its newest endpoint, never an older event. */
 setPressureAdvanceAtTail(change:TimedPressureBoundary):void{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot update pressure tail');
  this.#beginWork();this.#busy=true;
  try{for(const guard of this.#guards)guard.assertActive();const b=this.#bindings.find(b=>b.id===change.stepper);if(!b||!b.stepper.pressureAdvanceEnabled)throw new RangeError('Invalid pressure tail emitter');b.stepper.setPressureAdvanceAtTail(change.time,change.advance);}
  catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  finally{this.#busy=false;this.#endWork();}
 }
 /** Synchronous source transaction; a partial native update is terminal. */
 schedulePressureBoundaries(changes:readonly TimedPressureBoundary[]):void{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot schedule pressure');
  this.#beginWork();this.#busy=true;
  try{for(const guard of this.#guards)guard.assertActive();this.#schedulePressure(changes);}
  catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  finally{this.#busy=false;this.#endWork();}
 }
 #schedulePressure(changes:readonly TimedPressureBoundary[]):void{
  if(!Array.isArray(changes)||changes.length>65536)throw new RangeError('Invalid scheduled pressure batch');
  const previous=new Map<string,number>();
  const staged=changes.map(c=>{const b=this.#bindings.find(b=>b.id===c.stepper);if(!b||!b.stepper.pressureAdvanceEnabled||!Number.isFinite(c.advance)||c.advance<=0||!Number.isFinite(c.time)||c.time>=1e15||c.time<=Math.max(previous.get(c.stepper)??-Infinity,b.stepper.generatedTime+b.stepper.scanWindow.future))throw new RangeError('Invalid pressure endpoint or emitter');previous.set(c.stepper,c.time);return {stepper:b.stepper,time:c.time,advance:c.advance};});
  for(const c of staged)c.stepper.schedulePressureAdvance(c.time,c.advance);
 }
 /** Fenced source-owner transaction. No generation or packet submission can
  * interleave. A partial native rewrite is terminal, never a recoverable retry. */
 async replaceFuture(time:number,moves:readonly Move[],routes:readonly {queue:TrapQueue;extrusionAxis?:number}[],position:readonly number[]):Promise<number>{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot replace future');
  if(!this.usesQueues(routes.map(r=>r.queue))||!Number.isFinite(time)||time>=1e15||position.length<4||!position.every(Number.isFinite))throw new RangeError('Invalid future replacement ownership');
  this.#beginWork();this.#busy=true;
  try{
   for(const guard of this.#guards)guard.assertActive();
   for(const b of this.#bindings)if(time<=b.stepper.generatedTime+b.stepper.scanWindow.future)throw new RangeError('Replacement overlaps generated filter dependencies');
   // Parameter history belongs to the source being replaced. Fence all
   // emitters first, then remove its discarded suffix before generating any
   // brake phase. A failure after one mutation retires the whole group below.
   for(const b of this.#bindings)if(b.stepper.pressureAdvanceEnabled)b.stepper.cancelPressureAdvanceAfter(time);
   let end:number|undefined;
   for(const r of routes){
    let next:number;if(moves.length)next=r.queue.replaceFuturePlanned(moves,time,r.extrusionAxis,true);
    else{const p=r.extrusionAxis===undefined?position.slice(0,3):[position[r.extrusionAxis],0,0];next=time+.001;r.queue.replaceFutureRaw(time,new Float64Array([time,0,next-time,0,...p,0,0,0,0,0,0]));}
    if(end!==undefined&&next!==end)throw new Error('Replaced queue timelines differ');end=next;
   }
   for(const guard of this.#guards)guard.assertActive();if(this.#failed)throw this.#fault;
   if(moves.some(m=>m.pressureBoundaries?.length))this.#schedulePressure(pressureBoundarySchedule(moves,time));
   return end!;
  }catch(error){try{await this.shutdown(error);}catch{/* Retained with original failure. */}throw this.#fault;}
  finally{this.#busy=false;this.#endWork();}
 }
 usesBindings(bindings:readonly MotionBinding[]):boolean{return bindings.length===this.#bindings.length&&new Set(bindings.map(b=>b.id)).size===bindings.length&&bindings.every(b=>this.#bindings.some(owned=>owned.id===b.id&&owned.queue===b.queue&&owned.stepper===b.stepper));}
 get status(){return {generatedTime:this.#generated,committedTime:this.#committed,busy:this.#busy||this.#bounded,failed:this.#failed,retired:this.#retired,fault:this.#fault};}
 /** Retirement requested is not sufficient: accepted commits must settle. */
 get retirementComplete():boolean{return this.#retirementComplete&&!this.#failed;}
 /** Freeze this generation permanently. The owner must establish the affected
  * MCU stop/reset-required boundary before any replacement commands. Accepted
  * commands may execute until that stop; resetting requires BOTH confirmation
  * and retirement. Success permits native queue disposal. */
 retire(signal:AbortSignal):Promise<void>{
  if(this.#retirement)return this.#retirement;
  if(this.#failed||!this.#sink.retire)return Promise.reject(new Error('Motion coordinator cannot retire'));
  this.#retired=true;
  this.#retirement=(async()=>{
   try{await observeRetirement(this.#sink.retire!(signal),signal);await observeRetirement(this.#idle,signal);if(this.#failed)throw this.#fault;for(const guard of this.#guards)guard.assertActive();this.#retirementComplete=true;this.#releaseHistory();}
   catch(error){try{await this.shutdown(error);}catch{/* Both failures remain in status. */}throw this.#fault;}
  })();return this.#retirement;
 }
 shutdown(cause:unknown=new Error('Motion shutdown requested')):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#failed=true;this.#fault=cause;
  this.#stopPromise=Promise.resolve().then(()=>this.#sink.stop(cause)).catch(stopError=>{this.#fault=new AggregateError([cause,stopError],'Motion failure and device stop failure');throw this.#fault;}).finally(()=>this.#releaseHistory());
  return this.#stopPromise;
 }
 /** Caller selects every emitter belonging to the calibrated MCU. No awaits
  * are allowed between validation and application to the entire group. */
 calibrateClock(ids:readonly string[],offset:number,frequency:number):void{
  if(this.#retired||this.#busy||this.#bounded||this.#failed)throw new Error('Clock calibration requires an idle healthy coordinator');
  if(!ids.length||new Set(ids).size!==ids.length)throw new Error('Invalid calibration group');
  const bindings=ids.map(id=>{const b=this.#bindings.find(b=>b.id===id);if(!b)throw new Error('Unknown calibration emitter');return b;});
  try{for(const guard of this.#guards)guard.assertActive();}catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  for(const b of bindings)b.stepper.validateClockCalibration(offset,frequency);
  try{for(const b of bindings)b.stepper.calibrateClock(offset,frequency);}catch(error){void this.shutdown(error).catch(()=>{});throw error;}
 }
 /** Synchronous shared-timeline transaction. No unsolved interval may use the
  * new affine mapping before its effective boundary. */
 calibrateClockAtBoundary(ids:readonly string[],previous:Readonly<{offset:number;frequency:number}>,next:Readonly<{offset:number;frequency:number}>,time:number):void{
  if(!Number.isFinite(time)||time!==this.#generated)throw new Error('Calibration requires the generated motion boundary');
  for(const id of ids){const b=this.#bindings.find(b=>b.id===id);if(!b)throw new Error('Unknown calibration emitter');const old=b.stepper.calibration;if(b.stepper.generatedTime!==time||old.offset!==previous.offset||old.frequency!==previous.frequency)throw new Error('Motion and shared clock mappings differ');}
  this.calibrateClock(ids,next.offset,next.frequency);
 }
 /** Extend native generation without flushing or yielding. Caller proves
  * source coverage and immediately publishes calibration in the same stack.
  * At most 10 ms of extra work; a partial native failure is terminal. */
 generateCalibrationBoundary(until:number):void{
  if(this.#retired||this.#busy||this.#bounded||this.#failed)throw new Error('Calibration generation requires an idle healthy coordinator');
  if(!Number.isFinite(until)||until<=this.#generated||until-this.#generated>.01||until>=1e15)throw new RangeError('Invalid calibration generation boundary');
  this.#beginWork();this.#busy=true;
  try{for(const guard of this.#guards)guard.assertActive();for(const b of this.#bindings)b.stepper.generate(until);this.#generated=until;for(const guard of this.#guards)guard.assertActive();}
  catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  finally{this.#busy=false;this.#endWork();}
 }
 /** Close a producer-stopped motion boundary with stationary convolution data.
  * positions must give each bound queue's exact endpoint at lastMoveTime; no
  * later source motion may already be appended. Failure after padding is terminal.
  * Returned clocks still require transport ACK and MCU-time observation. */
 async drain(lastMoveTime:number,positions:ReadonlyMap<TrapQueue,readonly [number,number,number]>,maxWindowSeconds?:number,historyClock?:()=>number,reservedPressureHalfWindow=0):Promise<{readonly clocks:Readonly<Record<string,bigint>>;readonly generatedUntil:number;readonly sourceUntil:number}>{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot drain');
  if(historyClock!==undefined&&maxWindowSeconds===undefined)throw new RangeError('History clock requires bounded generation');
  if(!Number.isFinite(reservedPressureHalfWindow)||reservedPressureHalfWindow<0||reservedPressureHalfWindow>.1)throw new RangeError('Invalid reserved pressure window');
  const queues=new Set(this.#bindings.map(b=>b.queue));
  if(!Number.isFinite(lastMoveTime)||lastMoveTime<this.#generated||lastMoveTime>=1e15||positions.size!==queues.size||[...positions].some(([q,p])=>!queues.has(q)||!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))throw new RangeError('Invalid motion drain endpoints');
  let past=reservedPressureHalfWindow,future=reservedPressureHalfWindow;for(const b of this.#bindings){const w=b.stepper.scanWindow;past=Math.max(past,w.past);future=Math.max(future,w.future);}
  const until=lastMoveTime+past+.001,sourceUntil=until+future+.001;
  if(!Number.isFinite(sourceUntil)||sourceUntil>=1e15||until<=lastMoveTime||sourceUntil<=until||sourceUntil-until<future)throw new RangeError('Unrepresentable motion drain horizon');
  const clocks:Record<string,bigint>=Object.create(null);for(const b of this.#bindings)clocks[b.id]=b.stepper.clockAt(until);
  try{
   for(const guard of this.#guards)guard.assertActive();
   for(const q of queues)q.appendRaw(stationaryRows(lastMoveTime,sourceUntil,positions.get(q)!));
   if(maxWindowSeconds===undefined)await this.advance(until);else await this.advanceBounded(until,0,until,maxWindowSeconds,historyClock);return Object.freeze({clocks:Object.freeze(clocks),generatedUntil:until,sourceUntil});
  }catch(error){if(error instanceof MotionRetiredError&&this.#retired&&!this.#failed)throw error;try{await this.shutdown(error);}catch{/* Original and stop failures remain in status. */}throw this.#fault;}
 }
 /** Generate only where every solver has its required future source data.
  * Does not pad a stop or wait for MCU execution. Caller owns sourceUntil. */
 async advanceSource(sourceUntil:number,clearHistoryTime=0,maxWindowSeconds?:number,historyClock?:()=>number):Promise<boolean>{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot stream');
  if(historyClock!==undefined&&maxWindowSeconds===undefined)throw new RangeError('History clock requires bounded generation');
  if(!Number.isFinite(sourceUntil)||sourceUntil<this.#generated||sourceUntil>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0)throw new RangeError('Invalid source horizon');
  let future=0;for(const b of this.#bindings)future=Math.max(future,b.stepper.scanWindow.future);
  const generation=sourceUntil-future-.001,flush=generation-.002;
  if(generation<this.#generated||flush<this.#committed||generation===this.#generated&&flush===this.#committed)return false;
  if(sourceUntil-generation<future||generation-flush<.001||clearHistoryTime>flush)throw new RangeError('Unrepresentable streaming horizon');
  if(maxWindowSeconds===undefined)await this.advanceWindow(generation,flush,clearHistoryTime);else await this.advanceBounded(generation,clearHistoryTime,flush,maxWindowSeconds,historyClock);return true;
 }
 /** Advance a source interval that the exclusive producer declares idle.
  * Flush every generated pulse into a private batch and reject any motion
  * before commit; never use this shortcut to skip real queued trajectories. */
 async advanceIdleSource(sourceUntil:number,clearHistoryTime=0):Promise<boolean>{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot advance idle source');
  if(!Number.isFinite(sourceUntil)||sourceUntil<this.#generated||sourceUntil>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0)throw new RangeError('Invalid idle source horizon');
  let future=0,past=0;for(const b of this.#bindings){const w=b.stepper.scanWindow;future=Math.max(future,w.future);past=Math.max(past,w.past);}
  // Short startup padding still needs the first ordinary generation window;
  // finalizing before the existing baseline would discard filter history.
  const until=sourceUntil-future-.001;if(until-this.#generated<=past+.001)return false;
  if(sourceUntil-until<future||clearHistoryTime>until)throw new RangeError('Unrepresentable idle source horizon');
  await this.#advance(until,clearHistoryTime,until,true);return true;
 }
 /** Rolling generation keeps at least the original 1 ms step-direction filter horizon. */
 advanceWindow(generationUntil:number,flushUntil:number,clearHistoryTime=0):Promise<void>{
  if(!Number.isFinite(flushUntil)||generationUntil<flushUntil+.001)return Promise.reject(new RangeError('Generation must lead flush by at least 1 ms'));
  return this.advance(generationUntil,clearHistoryTime,flushUntil);
 }
 /** With no flushUntil, drain through generation time; use at coordinated boundaries. */
 advance(until:number,clearHistoryTime=0,flushUntil=until):Promise<void>{
  if(this.#retired)return Promise.reject(new MotionRetiredError());
  if(this.#bounded)return Promise.reject(new Error('Motion window operation already in progress'));
  return this.#advance(until,clearHistoryTime,flushUntil);
 }
 /** Bound native work in time while retaining direction-filter lookahead.
  * Source queues must include stationary startup coverage from their baseline.
  * Native step/byte budgets still apply to each window; failure stops all
  * bindings and does not replay prefixes accepted by earlier windows. */
 async advanceBounded(until:number,clearHistoryTime=0,flushUntil=until,maxWindowSeconds=.25,historyClock?:()=>number):Promise<void>{
  if(this.#retired||this.#failed||this.#busy||this.#bounded)throw new Error('Motion coordinator cannot start bounded generation');
  if(!Number.isFinite(until)||until<this.#generated||until>=1e15||!Number.isFinite(flushUntil)||flushUntil<this.#committed||flushUntil>until||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0||clearHistoryTime>flushUntil||!Number.isFinite(maxWindowSeconds)||maxWindowSeconds<.01||maxWindowSeconds>1||Math.ceil((until-this.#generated)/maxWindowSeconds)>1000000)throw new RangeError('Invalid bounded generation limits');
  if(historyClock!==undefined&&typeof historyClock!=='function')throw new TypeError('Invalid history clock');
  const history=(flush:number)=>{const cutoff=historyClock?historyClock():clearHistoryTime;if(!Number.isFinite(cutoff)||cutoff<0)throw new RangeError('Invalid observed history cutoff');return Math.min(cutoff,flush);};
  this.#beginWork();this.#bounded=true;let windows=0;
  try{
   while(this.#generated<until){
    // The first convolution evaluation needs retained startup padding before
    // ordinary windows can begin. Native continuity/budget guards still apply.
    let span=maxWindowSeconds;if(this.#generated===0)for(const b of this.#bindings)span=Math.max(span,b.stepper.scanWindow.past+.001);
    const next=Math.min(until,this.#generated+span);if(next<=this.#generated)throw new RangeError('Unrepresentable generation window');
    const flush=next===until?flushUntil:Math.max(this.#committed,Math.min(flushUntil,next-.002));
    await this.#advance(next,history(flush),flush);
    if(++windows%8===0&&this.#generated<until)await new Promise<void>(resolve=>setImmediate(resolve));
   }
   if(this.#committed<flushUntil)await this.#advance(until,history(flushUntil),flushUntil);
  }catch(error){if(error instanceof MotionRetiredError&&this.#retired&&!this.#failed)throw error;try{await this.shutdown(error);}catch{/* Original and stop failures remain in status. */}throw this.#fault;}finally{this.#bounded=false;this.#endWork();}
 }
 async #advance(until:number,clearHistoryTime=0,flushUntil=until,idle=false):Promise<void>{
  if(this.#failed)throw new Error('Motion coordinator is faulted',{cause:this.#fault});
  if(this.#retired)throw new MotionRetiredError();
  if(this.#busy)throw new Error('Motion batch already in progress');
  if(!Number.isFinite(until)||until<this.#generated||until>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0||clearHistoryTime>flushUntil||!Number.isFinite(flushUntil)||flushUntil<this.#committed||flushUntil>until)throw new RangeError('Invalid motion batch times');
  if(until===this.#generated&&flushUntil===this.#committed)return;
  this.#beginWork();this.#busy=true;
  try{
   for(const guard of this.#guards)guard.assertActive();
   const from=this.#committed;
   // No packets leave the host until every attached actuator has generated.
   if(until>this.#generated)for(const b of this.#bindings)b.stepper.generate(until);
   this.#generated=until;
   if(flushUntil===this.#committed)return;
   const outputs:MotionOutput[]=[];let bytes=0;
   for(const b of this.#bindings){
    const out=b.stepper.flushThrough(flushUntil);
    if(idle&&out.history.some((value,index)=>index%6===3&&value!==0n))throw new Error('Idle advance contains step motion');
    bytes+=out.history.byteLength;
    for(const p of out.messages)bytes+=p.data.length+32;
    if(bytes>this.#maxBytes)throw new RangeError('Motion output exceeds batch budget');
    outputs.push({...out,id:b.id});
   }
   for(const guard of this.#guards)guard.assertActive();
   await this.#sink.commit({sequence:this.#sequence++,from,until:flushUntil,generatedUntil:until,outputs});
   for(const guard of this.#guards)guard.assertActive();
   if(this.#failed)throw this.#fault;
   if(this.#retired)throw new MotionRetiredError();
   this.#committed=flushUntil;
   // Shared XYZ queues wait for the largest retained convolution window.
   const cutoffs=new Map<TrapQueue,number|null>();
   for(const b of this.#bindings){const time=b.stepper.scanWindow.safeFinalizeTime,old=cutoffs.get(b.queue);
    cutoffs.set(b.queue,old===null||time===null?null:old===undefined?time:Math.min(old,time));}
   let complete=true,finalized=Infinity;
   // A short first window may still retain convolution history before the
   // reset baseline. Keep that queue untouched; never rewind native cleanup
   // or clamp cleanup forward into a solver's retained dependency window.
   for(const [queue,time] of cutoffs){if(time===null||time<this.#baseline){complete=false;continue;}queue.finalize(time,Math.min(time,clearHistoryTime));finalized=Math.min(finalized,time);}
   if(complete)this.#finalizedSourceTime=Math.max(this.#finalizedSourceTime,finalized);
  }catch(error){
   if(error instanceof MotionRetiredError&&this.#retired&&!this.#failed)throw error;
   try{await this.shutdown(error);}catch{/* Failure is retained in status. */}
   throw this.#fault;
  }finally{this.#busy=false;this.#endWork();}
 }
}
