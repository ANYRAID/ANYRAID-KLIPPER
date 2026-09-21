import type {StepCompressor,CompressedSteps} from './step-compressor.ts';
import type {TrapQueue} from './trap-queue.ts';
export interface MotionBinding {id:string;queue:TrapQueue;stepper:StepCompressor}
export interface MotionOutput extends CompressedSteps {id:string}
export interface MotionBatch {sequence:number;from:number;until:number;generatedUntil?:number;outputs:readonly MotionOutput[]}
export interface MotionSink {
 /** Preserve each output's packet order, route to its MCU, and retain homing history.
  * Resolve after accepting the entire batch. Rejection may mean partial acceptance. */
 commit(batch:Readonly<MotionBatch>):Promise<void>;
 /** Fence in-flight/future commits, cancel queued motion and stop all affected devices. */
 stop(cause:unknown):Promise<void>;
}
/** Single-use coordination of native step generation. Does not implement the MCU
 * move-slot scheduler, clock calibration, serial transport or hardware watchdog. */
export class MotionCoordinator {
 #guards:readonly {assertActive():void}[];
 #bindings:readonly MotionBinding[];#sink:MotionSink;#busy=false;#fault:unknown;#failed=false;
 #stopPromise:Promise<void>|undefined;
 #finalizedSourceTime=0;#generated:number;#committed:number;#sequence=0;#maxBytes:number;
 constructor(bindings:readonly MotionBinding[],sink:MotionSink,maxBatchBytes=16*1024*1024,initialCommittedTime=0,clockHealth:readonly {assertActive():void}[]=[]){
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
  this.#bindings=bindings.map(b=>({...b}));this.#sink=sink;this.#generated=this.#committed=time;this.#maxBytes=maxBatchBytes;
 }
 /** Common lower bound actually finalized in every source queue. */
 get finalizedSourceTime():number{return this.#finalizedSourceTime;}
 usesQueues(queues:readonly TrapQueue[]):boolean{const owned=new Set(this.#bindings.map(b=>b.queue));return queues.length===owned.size&&new Set(queues).size===owned.size&&queues.every(q=>owned.has(q));}
 usesSink(sink:MotionSink):boolean{return this.#sink===sink;}
 get status(){return {generatedTime:this.#generated,committedTime:this.#committed,busy:this.#busy,failed:this.#failed,fault:this.#fault};}
 shutdown(cause:unknown=new Error('Motion shutdown requested')):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#failed=true;this.#fault=cause;
  this.#stopPromise=Promise.resolve().then(()=>this.#sink.stop(cause)).catch(stopError=>{this.#fault=new AggregateError([cause,stopError],'Motion failure and device stop failure');throw this.#fault;});
  return this.#stopPromise;
 }
 /** Caller selects every emitter belonging to the calibrated MCU. No awaits
  * are allowed between validation and application to the entire group. */
 calibrateClock(ids:readonly string[],offset:number,frequency:number):void{
  if(this.#busy||this.#failed)throw new Error('Clock calibration requires an idle healthy coordinator');
  if(!ids.length||new Set(ids).size!==ids.length)throw new Error('Invalid calibration group');
  const bindings=ids.map(id=>{const b=this.#bindings.find(b=>b.id===id);if(!b)throw new Error('Unknown calibration emitter');return b;});
  try{for(const guard of this.#guards)guard.assertActive();}catch(error){void this.shutdown(error).catch(()=>{});throw error;}
  for(const b of bindings)b.stepper.validateClockCalibration(offset,frequency);
  for(const b of bindings)b.stepper.calibrateClock(offset,frequency);
 }
 /** Close a producer-stopped motion boundary with stationary convolution data.
  * positions must give each bound queue's exact endpoint at lastMoveTime; no
  * later source motion may already be appended. Failure after padding is terminal.
  * Returned clocks still require transport ACK and MCU-time observation. */
 async drain(lastMoveTime:number,positions:ReadonlyMap<TrapQueue,readonly [number,number,number]>):Promise<{readonly clocks:Readonly<Record<string,bigint>>;readonly generatedUntil:number;readonly sourceUntil:number}>{
  if(this.#failed||this.#busy)throw new Error('Motion coordinator cannot drain');
  const queues=new Set(this.#bindings.map(b=>b.queue));
  if(!Number.isFinite(lastMoveTime)||lastMoveTime<this.#generated||lastMoveTime>=1e15||positions.size!==queues.size||[...positions].some(([q,p])=>!queues.has(q)||!Array.isArray(p)||p.length!==3||!p.every(Number.isFinite)))throw new RangeError('Invalid motion drain endpoints');
  let past=0,future=0;for(const b of this.#bindings){const w=b.stepper.scanWindow;past=Math.max(past,w.past);future=Math.max(future,w.future);}
  const until=lastMoveTime+past+.001,sourceUntil=until+future+.001;
  if(!Number.isFinite(sourceUntil)||sourceUntil>=1e15||until<=lastMoveTime||sourceUntil<=until||sourceUntil-until<future)throw new RangeError('Unrepresentable motion drain horizon');
  const clocks:Record<string,bigint>=Object.create(null);for(const b of this.#bindings)clocks[b.id]=b.stepper.clockAt(until);
  try{
   for(const guard of this.#guards)guard.assertActive();
   for(const q of queues){const p=positions.get(q)!;q.appendRaw(new Float64Array([lastMoveTime,0,sourceUntil-lastMoveTime,0,...p,0,0,0,0,0,0]));}
   await this.advance(until);return Object.freeze({clocks:Object.freeze(clocks),generatedUntil:until,sourceUntil});
  }catch(error){try{await this.shutdown(error);}catch{/* Original and stop failures remain in status. */}throw this.#fault;}
 }
 /** Generate only where every solver has its required future source data.
  * Does not pad a stop or wait for MCU execution. Caller owns sourceUntil. */
 async advanceSource(sourceUntil:number,clearHistoryTime=0):Promise<boolean>{
  if(this.#failed||this.#busy)throw new Error('Motion coordinator cannot stream');
  if(!Number.isFinite(sourceUntil)||sourceUntil<this.#generated||sourceUntil>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0)throw new RangeError('Invalid source horizon');
  let future=0;for(const b of this.#bindings)future=Math.max(future,b.stepper.scanWindow.future);
  const generation=sourceUntil-future-.001,flush=generation-.002;
  if(generation<=this.#generated||flush<this.#committed)return false;
  if(sourceUntil-generation<future||generation-flush<.001||clearHistoryTime>flush)throw new RangeError('Unrepresentable streaming horizon');
  await this.advanceWindow(generation,flush,clearHistoryTime);return true;
 }
 /** Rolling generation keeps at least the original 1 ms step-direction filter horizon. */
 advanceWindow(generationUntil:number,flushUntil:number,clearHistoryTime=0):Promise<void>{
  if(!Number.isFinite(flushUntil)||generationUntil<flushUntil+.001)return Promise.reject(new RangeError('Generation must lead flush by at least 1 ms'));
  return this.advance(generationUntil,clearHistoryTime,flushUntil);
 }
 /** With no flushUntil, drain through generation time; use at coordinated boundaries. */
 async advance(until:number,clearHistoryTime=0,flushUntil=until):Promise<void>{
  if(this.#failed)throw new Error('Motion coordinator is faulted',{cause:this.#fault});
  if(this.#busy)throw new Error('Motion batch already in progress');
  if(!Number.isFinite(until)||until<this.#generated||until>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0||clearHistoryTime>flushUntil||!Number.isFinite(flushUntil)||flushUntil<this.#committed||flushUntil>until)throw new RangeError('Invalid motion batch times');
  if(until===this.#generated&&flushUntil===this.#committed)return;
  this.#busy=true;
  try{
   for(const guard of this.#guards)guard.assertActive();
   const from=this.#committed;
   // No packets leave the host until every attached actuator has generated.
   if(until>this.#generated)for(const b of this.#bindings)b.stepper.generate(until);
   this.#generated=until;
   if(flushUntil===this.#committed)return;
   const outputs:MotionOutput[]=[];let bytes=0;
   for(const b of this.#bindings){
    const out=b.stepper.flushThrough(flushUntil);bytes+=out.history.byteLength;
    for(const p of out.messages)bytes+=p.data.length+32;
    if(bytes>this.#maxBytes)throw new RangeError('Motion output exceeds batch budget');
    outputs.push({...out,id:b.id});
   }
   for(const guard of this.#guards)guard.assertActive();
   await this.#sink.commit({sequence:this.#sequence++,from,until:flushUntil,generatedUntil:until,outputs});
   for(const guard of this.#guards)guard.assertActive();
   if(this.#failed)throw this.#fault;
   this.#committed=flushUntil;
   // Shared XYZ queues wait for the largest retained convolution window.
   const cutoffs=new Map<TrapQueue,number|null>();
   for(const b of this.#bindings){const time=b.stepper.scanWindow.safeFinalizeTime,old=cutoffs.get(b.queue);
    cutoffs.set(b.queue,old===null||time===null?null:old===undefined?time:Math.min(old,time));}
   let complete=true,finalized=Infinity;
   for(const [queue,time] of cutoffs){if(time===null){complete=false;continue;}queue.finalize(time,Math.min(time,clearHistoryTime));finalized=Math.min(finalized,time);}
   if(complete)this.#finalizedSourceTime=Math.max(this.#finalizedSourceTime,finalized);
  }catch(error){
   try{await this.shutdown(error);}catch{/* Failure is retained in status. */}
   throw this.#fault;
  }finally{this.#busy=false;}
 }
}
