import type {StepCompressor,CompressedSteps} from './step-compressor.ts';
import type {TrapQueue} from './trap-queue.ts';
export interface MotionBinding {id:string;queue:TrapQueue;stepper:StepCompressor}
export interface MotionOutput extends CompressedSteps {id:string}
export interface MotionBatch {sequence:number;from:number;until:number;outputs:readonly MotionOutput[]}
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
 #bindings:readonly MotionBinding[];#sink:MotionSink;#busy=false;#fault:unknown;#failed=false;
 #stopPromise:Promise<void>|undefined;
 #generated:number;#committed:number;#sequence=0;#maxBytes:number;
 constructor(bindings:readonly MotionBinding[],sink:MotionSink,maxBatchBytes=16*1024*1024,initialCommittedTime=0){
  if(!bindings.length||bindings.length>128||!Number.isSafeInteger(maxBatchBytes)||maxBatchBytes<1)throw new RangeError('Invalid motion coordinator limits');
  const ids=new Set<string>(),steppers=new Set<StepCompressor>();
  for(const b of bindings){
   if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(b.id)||ids.has(b.id)||steppers.has(b.stepper)||!b.queue.ownsStepper(b.stepper))throw new Error('Invalid or duplicate motion binding');
   ids.add(b.id);steppers.add(b.stepper);
  }
  if(!Number.isFinite(initialCommittedTime)||initialCommittedTime<0||initialCommittedTime>=1e15)throw new RangeError('Invalid initial committed time');
  const time=initialCommittedTime;
  if(bindings.some(b=>b.stepper.generatedTime!==time))throw new Error('Steppers must match the declared committed baseline');
  this.#bindings=bindings.map(b=>({...b}));this.#sink=sink;this.#generated=this.#committed=time;this.#maxBytes=maxBatchBytes;
 }
 get status(){return {generatedTime:this.#generated,committedTime:this.#committed,busy:this.#busy,failed:this.#failed,fault:this.#fault};}
 shutdown(cause:unknown=new Error('Motion shutdown requested')):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#failed=true;this.#fault=cause;
  this.#stopPromise=Promise.resolve().then(()=>this.#sink.stop(cause)).catch(stopError=>{this.#fault=new AggregateError([cause,stopError],'Motion failure and device stop failure');throw this.#fault;});
  return this.#stopPromise;
 }
 async advance(until:number,clearHistoryTime=0):Promise<void>{
  if(this.#failed)throw new Error('Motion coordinator is faulted',{cause:this.#fault});
  if(this.#busy)throw new Error('Motion batch already in progress');
  if(!Number.isFinite(until)||until<this.#generated||until>=1e15||!Number.isFinite(clearHistoryTime)||clearHistoryTime<0||clearHistoryTime>until)throw new RangeError('Invalid motion batch times');
  if(until===this.#generated)return;
  this.#busy=true;
  try{
   const from=this.#generated;
   // No packets leave the host until every attached actuator has generated.
   for(const b of this.#bindings)b.stepper.generate(until);
   this.#generated=until;
   const outputs:MotionOutput[]=[];let bytes=0;
   for(const b of this.#bindings){
    const out=b.stepper.flush();bytes+=out.history.byteLength;
    for(const p of out.messages)bytes+=p.data.length+32;
    if(bytes>this.#maxBytes)throw new RangeError('Motion output exceeds batch budget');
    outputs.push({...out,id:b.id});
   }
   await this.#sink.commit({sequence:this.#sequence++,from,until,outputs});
   if(this.#failed)throw this.#fault;
   this.#committed=until;
   // Shared XYZ queues wait for the largest retained convolution window.
   const cutoffs=new Map<TrapQueue,number|null>();
   for(const b of this.#bindings){const time=b.stepper.scanWindow.safeFinalizeTime,old=cutoffs.get(b.queue);
    cutoffs.set(b.queue,old===null||time===null?null:old===undefined?time:Math.min(old,time));}
   for(const [queue,time] of cutoffs)if(time!==null)queue.finalize(time,Math.min(time,clearHistoryTime));
  }catch(error){
   try{await this.shutdown(error);}catch{/* Failure is retained in status. */}
   throw this.#fault;
  }finally{this.#busy=false;}
 }
}
