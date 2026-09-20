import {PWMOutput,type CompiledPWM} from './pwm.ts';
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {TimedCommandQueue} from '../protocol/serial-session.ts';
export class PWMGenerationSuperseded extends Error {}
/** Requires distinct timed-output and immediate-control FIFOs on the same MCU.
 * reset() confirms the firmware reset AND drains old host sends before reuse.
 * Firmware acknowledgement is not electrical feedback from the pin. */
export class GenerationPWMOutput {
 #config:CompiledPWM;#dictionary:MessageDictionary;#data:TimedCommandQueue;#control:TimedCommandQueue;
 #clockAt:(time:number)=>bigint;#printAt:(clock:bigint)=>number;#writer:PWMOutput|undefined;
 #phase:'idle'|'resetting'|'ready'|'failed'='idle';#generation=0;#offConfirmed=false;
 #pending=new Set<Promise<void>>();#reset:Promise<void>|undefined;#stop:Promise<void>|undefined;#fault:unknown;#stopError:unknown;
 constructor(config:CompiledPWM,dictionary:MessageDictionary,data:TimedCommandQueue,control:TimedCommandQueue,clockAt:(time:number)=>bigint,printAt:(clock:bigint)=>number){
  if(data===control)throw new Error('PWM reset requires an independent control queue');
  dictionary.lookup(config.hardware?'reset_pwm_out_generation oid=%c generation=%u':'reset_digital_out_generation oid=%c generation=%u');
  dictionary.lookup(config.hardware?'queue_pwm_out_generation oid=%c clock=%u value=%hu generation=%u':'queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
  if(!Number.isFinite(config.shutdownValue)||config.shutdownValue<0||config.shutdownValue>1)throw new RangeError('Invalid PWM shutdown default');
  this.#config={...config};this.#dictionary=dictionary;this.#data=data;this.#control=control;this.#clockAt=clockAt;this.#printAt=printAt;
 }
 get status(){return {phase:this.#phase,generation:this.#generation,defaultConfirmed:this.#offConfirmed,pendingWrites:this.#pending.size,fault:this.#fault,stopError:this.#stopError};}
 #assertNotFailed():void{if(this.#phase==='failed')throw this.#fault;}
 #assertReady():void{if(this.#phase!=='ready')throw new Error('PWM generation is not ready',{cause:this.#fault});}
 nextAlignedPrintTime(time:number,allowEarly=0):number{this.#assertReady();return this.#writer!.nextAlignedPrintTime(time,allowEarly);}
 async setPWM(time:number,value:number,signal:AbortSignal):Promise<void>{
  this.#assertReady();const generation=this.#generation,writer=this.#writer!;
  await writer.setPWM(time,value,signal);
  this.#assertNotFailed();
  if(generation!==this.#generation)throw new PWMGenerationSuperseded('PWM write superseded by reset');
 }
 #send(payload:Uint8Array,min:bigint,req:bigint,signal:AbortSignal):Promise<void>{
  if(this.#pending.size>=32){const error=new Error('PWM pending write limit exceeded');void this.stop(error).catch(()=>{});return Promise.reject(error);}
  const pending=Promise.withResolvers<void>();this.#pending.add(pending.promise);this.#offConfirmed=false;
  void pending.promise.then(()=>this.#pending.delete(pending.promise),()=>this.#pending.delete(pending.promise));
  const fail=(error:unknown)=>{void this.stop(error).catch(()=>{});pending.reject(error);};
  try{Promise.resolve(this.#data.send(payload,min,req,signal)).then(pending.resolve,fail);}catch(error){fail(error);}
  return pending.promise;
 }
 reset(signal:AbortSignal):Promise<void>{
  if(this.#phase==='failed')return Promise.reject(new Error('PWM output is stopped',{cause:this.#fault}));
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
  if(this.#generation===0xffffffff){const error=new Error('PWM generation exhausted');return this.stop(error).then(()=>{throw error;});}
  const deferred=Promise.withResolvers<void>();this.#reset=deferred.promise;this.#phase='resetting';this.#offConfirmed=false;
  const generation=++this.#generation,old=[...this.#pending];this.#writer=undefined;
  const abort=()=>{const reason=signal.reason??new Error('PWM reset aborted');void this.stop(reason).then(()=>deferred.reject(reason),deferred.reject);};
  signal.addEventListener('abort',abort,{once:true});
  const finish=()=>{signal.removeEventListener('abort',abort);if(this.#reset===deferred.promise)this.#reset=undefined;};
  void (async()=>{
   const payload=this.#dictionary.encode(this.#config.hardware?'reset_pwm_out_generation':'reset_digital_out_generation',{oid:this.#config.oid,generation});
   await this.#control.send(payload,0n,0n,signal);
   this.#assertNotFailed();
   this.#offConfirmed=true;
   const settled=await Promise.allSettled(old);signal.throwIfAborted();
   const rejected=settled.find(result=>result.status==='rejected');if(rejected)throw rejected.reason;
   this.#assertNotFailed();
   return new PWMOutput({...this.#config,initialClock:0n,startValue:this.#config.shutdownValue},this.#dictionary,{send:(...args)=>this.#send(...args),stop:cause=>this.stop(cause)},this.#clockAt,this.#printAt,generation);
  })().then(writer=>{
   if(this.#phase==='failed'){finish();deferred.reject(this.#fault);return;}
   this.#writer=writer;this.#phase='ready';finish();deferred.resolve();
  },async error=>{
   try{await this.stop(error);deferred.reject(error);}catch(stopError){deferred.reject(new AggregateError([error,stopError],'PWM reset and stop failed',{cause:error}));}finally{finish();}
  });
  return deferred.promise;
 }
 stop(cause:unknown=new Error('PWM output stopped')):Promise<void>{
  if(this.#stop)return this.#stop;
  const deferred=Promise.withResolvers<void>();this.#stop=deferred.promise;this.#phase='failed';this.#fault=cause;this.#writer=undefined;
  void Promise.allSettled([Promise.resolve().then(()=>this.#data.stop(cause)),Promise.resolve().then(()=>this.#control.stop(cause))]).then(results=>{
   const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
   if(errors.length){this.#stopError=new AggregateError(errors,'PWM safety stop failed');deferred.reject(this.#stopError);}else deferred.resolve();
  });
  return deferred.promise;
 }
}
