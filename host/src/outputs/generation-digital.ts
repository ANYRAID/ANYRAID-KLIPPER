import {DigitalOutput,type CompiledDigital} from './digital.ts';
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {TimedCommandQueue} from '../protocol/serial-session.ts';
import {PrintClockTimeline} from '../timing/print-clock-timeline.ts';
export class DigitalGenerationSuperseded extends Error {}
/** Requires distinct timed-output and immediate-control FIFOs on the same MCU.
 * reset() confirms the firmware reset AND drains old host sends before reuse.
 * Firmware acknowledgement is not electrical feedback from the pin. */
export class GenerationDigitalOutput {
 /** Share one timeline across all outputs on this MCU. Queued writes reserve
  * their exact clock; resets do not release shared clock reservations. */
 static withClock(config:CompiledDigital,dictionary:MessageDictionary,data:TimedCommandQueue,control:TimedCommandQueue,clock:PrintClockTimeline):GenerationDigitalOutput{
  const output=new GenerationDigitalOutput(config,dictionary,data,control,time=>clock.reserve(time));
  return output;
 }
 #config:CompiledDigital;#dictionary:MessageDictionary;#data:TimedCommandQueue;#control:TimedCommandQueue;
 #clockAt:(time:number)=>bigint;#writer:DigitalOutput|undefined;
 #phase:'idle'|'resetting'|'ready'|'failed'='idle';#generation=0;#offConfirmed=false;
 #pending=new Set<Promise<void>>();#controls=new Set<Promise<void>>();#reset:Promise<void>|undefined;#stop:Promise<void>|undefined;#fault:unknown;#stopError:unknown;
 constructor(config:CompiledDigital,dictionary:MessageDictionary,data:TimedCommandQueue,control:TimedCommandQueue,clockAt:(time:number)=>bigint){
  if(data===control)throw new Error('Digital reset requires an independent control queue');
  dictionary.lookup('reset_digital_out_generation oid=%c generation=%u');
  dictionary.lookup('queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
  if(typeof config.shutdownValue!=='boolean'||typeof config.initialValue!=='boolean')throw new RangeError('Invalid digital defaults');
  this.#config={...config};this.#dictionary=dictionary;this.#data=data;this.#control=control;this.#clockAt=clockAt;
 }
 get configuration(){return {initialValue:this.#config.initialValue,defaultValue:this.#config.shutdownValue};}
 get status(){return {phase:this.#phase,generation:this.#generation,defaultConfirmed:this.#offConfirmed,pendingWrites:this.#pending.size,fault:this.#fault,stopError:this.#stopError};}
 #assertNotFailed():void{if(this.#phase==='failed')throw this.#fault;}
 #assertReady():void{if(this.#phase!=='ready')throw new Error('Digital generation is not ready',{cause:this.#fault});}
 async setDigital(time:number,value:boolean,signal:AbortSignal):Promise<void>{
  this.#assertReady();const generation=this.#generation,writer=this.#writer!;
  await writer.setDigital(time,value,signal);
  this.#assertNotFailed();
  if(generation!==this.#generation)throw new DigitalGenerationSuperseded('Digital write superseded by reset');
 }
 #send(payload:Uint8Array,min:bigint,req:bigint,signal:AbortSignal):Promise<void>{
  if(this.#pending.size>=32){const error=new Error('Digital pending write limit exceeded');void this.stop(error).catch(()=>{});return Promise.reject(error);}
  const pending=Promise.withResolvers<void>();this.#pending.add(pending.promise);this.#offConfirmed=false;
  void pending.promise.then(()=>this.#pending.delete(pending.promise),()=>this.#pending.delete(pending.promise));
  const fail=(error:unknown)=>{void this.stop(error).catch(()=>{});pending.reject(error);};
  try{Promise.resolve(this.#data.send(payload,min,req,signal)).then(pending.resolve,fail);}catch(error){fail(error);}
  return pending.promise;
 }
 reset(signal:AbortSignal):Promise<void>{
  if(this.#phase==='failed')return Promise.reject(new Error('Digital output is stopped',{cause:this.#fault}));
  if(signal.aborted)return Promise.reject(signal.reason);
  // Coalesce only callers observing the same uncancellable physical reset.
  if(this.#reset){
   const shared=this.#reset;
   return new Promise<void>((resolve,reject)=>{
    const abort=()=>{void this.stop(signal.reason).then(()=>reject(signal.reason),reject);};
    signal.addEventListener('abort',abort,{once:true});
    void shared.then(()=>{signal.removeEventListener('abort',abort);if(signal.aborted)reject(signal.reason);else resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
   });
  }
  if(this.#generation===0xffffffff){const error=new Error('Digital generation exhausted');return this.stop(error).then(()=>{throw error;});}
  const deferred=Promise.withResolvers<void>();this.#reset=deferred.promise;this.#phase='resetting';this.#offConfirmed=false;
  const generation=++this.#generation,old=[...this.#pending];this.#writer=undefined;
  const abort=()=>{const reason=signal.reason??new Error('Digital reset aborted');void this.stop(reason).then(()=>deferred.reject(reason),deferred.reject);};
  signal.addEventListener('abort',abort,{once:true});
  const finish=()=>{signal.removeEventListener('abort',abort);if(this.#reset===deferred.promise)this.#reset=undefined;};
  void (async()=>{
   const payload=this.#dictionary.encode('reset_digital_out_generation',{oid:this.#config.oid,generation});
   // Track the raw transport transaction, never #reset itself: a reset error
   // waits for stop(), so waiting for #reset from stop() would form a cycle.
   const sent=Promise.withResolvers<void>();this.#controls.add(sent.promise);
   try{Promise.resolve(this.#control.send(payload,0n,0n,signal)).then(sent.resolve,sent.reject);}catch(error){sent.reject(error);}
   try{await sent.promise;}finally{this.#controls.delete(sent.promise);}
   this.#assertNotFailed();
   this.#offConfirmed=true;
   const settled=await Promise.allSettled(old);signal.throwIfAborted();
   const rejected=settled.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
   this.#assertNotFailed();
   return new DigitalOutput(this.#config,this.#dictionary,{send:(...args)=>this.#send(...args),stop:cause=>this.stop(cause)},this.#clockAt,generation);
  })().then(writer=>{
   if(this.#phase==='failed'){finish();deferred.reject(this.#fault);return;}
   this.#writer=writer;this.#phase='ready';finish();deferred.resolve();
  },async error=>{
   try{await this.stop(error);deferred.reject(error);}catch(stopError){deferred.reject(new AggregateError([error,stopError],'Digital reset and stop failed',{cause:error}));}finally{finish();}
  });
  return deferred.promise;
 }
 stop(cause:unknown=new Error('Digital output stopped')):Promise<void>{
  if(this.#stop)return this.#stop;
  const deferred=Promise.withResolvers<void>();this.#stop=deferred.promise;this.#phase='failed';this.#fault=cause;this.#writer=undefined;
  const pending=[...this.#pending,...this.#controls],jobs:Promise<void>[]=[];
  // Initiate both independent safety paths before returning to observers.
  // Publish #stop first so a reentrant caller sees this same completion fence.
  for(const queue of [this.#data,this.#control])try{jobs.push(Promise.resolve(queue.stop(cause)));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(async results=>{
   // Transport cancellation belongs to each caller's write/reset result. Stop
   // reports safety errors, but cannot finish before accepted sends settle.
   await Promise.allSettled(pending);
   const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
   if(errors.length){this.#stopError=new AggregateError(errors,'Digital safety stop failed');deferred.reject(this.#stopError);}else deferred.resolve();
  });
  return deferred.promise;
 }
}
