import type {PrintDevice,StartPrint} from './print.ts';
import {AsyncPrinterHeaters} from '../thermal/async-heaters.ts';
export type PrintCompletionAdmission=(work:(signal:AbortSignal)=>Promise<void>,signal:AbortSignal)=>Promise<void>;
/** The underlying device owns file/EOF validation and motion/output safety.
 * It must not independently set heater targets or replay heater macros. */
export class ThermalPrintDevice implements PrintDevice {
 #extruders:readonly string[];#pausedTargets:readonly {name:string;target:number}[]|undefined;
 #listeners=new Set<(cause:unknown)=>void>();
 #device:PrintDevice;#heaters:AsyncPrinterHeaters;#nozzle:string;#bed:string;
 #prepared=false;#job:Readonly<StartPrint>|undefined;#epoch=0;#actions=new Set<AbortController>();
 #stopping:Promise<void>|undefined;#fault:unknown;
 #completion:PrintCompletionAdmission;
 constructor(device:PrintDevice,heaters:AsyncPrinterHeaters,mapping:{nozzle:string;bed:string;extruders?:readonly string[]},completion:PrintCompletionAdmission=(work,signal)=>work(signal)){
  if(typeof completion!=='function')throw new TypeError('Invalid print completion admission');this.#completion=completion;
  for(const method of ['prepare','start','pause','resume','finish','stop'] as const)if(typeof device?.[method]!=='function')throw new TypeError('Incomplete print motion adapter');
  const names=heaters.status.available_heaters.map(name=>name.trim().split(/\s+/).at(-1));
  if(!names.includes(mapping.nozzle)||!names.includes(mapping.bed)||mapping.nozzle===mapping.bed||heaters.status.closed)throw new Error('Invalid print heater mapping');
  const extruders=[...(mapping.extruders??[mapping.nozzle])];if(!extruders.length||extruders.length>13||new Set(extruders).size!==extruders.length||!extruders.includes(mapping.nozzle)||extruders.some(name=>!names.includes(name)||name===mapping.bed))throw new Error('Invalid print extruder mapping');this.#extruders=Object.freeze(extruders);
  this.#device=device;this.#heaters=heaters;this.#nozzle=mapping.nozzle;this.#bed=mapping.bed;
  heaters.subscribeShutdown(reason=>{this.#setFault(new Error(reason));void this.stop().catch(()=>{});});
  device.subscribeFault?.(cause=>{this.#setFault(cause);void this.stop().catch(()=>{});});
 }
 subscribeEOF(listener:(requestId:string)=>void):()=>void{return this.#device.subscribeEOF?.(listener)??(()=>{});}
 subscribeFault(listener:(cause:unknown)=>void):()=>void{
  if(typeof listener!=='function'||this.#listeners.has(listener)||this.#listeners.size>=64)throw new Error('Invalid print fault subscription');
  if(this.#fault){listener(this.#fault);return ()=>{};}
  this.#listeners.add(listener);return ()=>{this.#listeners.delete(listener);};
 }
 #setFault(cause:unknown):void{
  // Requested stop reports its own failure through the joined stop promise.
  // Expected motion/heater shutdown notifications must not race cancellation.
  if(this.#stopping)return;
  if(this.#fault)return;this.#fault=cause;
  const listeners=[...this.#listeners];this.#listeners.clear();
  const errors:unknown[]=[];for(const listener of listeners)try{listener(cause);}catch(error){errors.push(error);}
  if(errors.length)this.#fault=new AggregateError([cause,...errors],'Print fault observers failed',{cause});
 }
 get status(){return {requestId:this.#job?.requestId,stopping:this.#stopping!==undefined,fault:this.#fault,pendingActions:this.#actions.size};}
 async #run(signal:AbortSignal,action:(local:AbortSignal,guard:()=>void)=>Promise<void>):Promise<void>{
  signal.throwIfAborted();if(this.#fault||this.#stopping)throw this.#fault??new Error('Print device is stopping');
  if(this.#actions.size>=8)throw new Error('Print device action capacity exceeded');
  const epoch=this.#epoch,controller=new AbortController(),local=AbortSignal.any([signal,controller.signal]);this.#actions.add(controller);
  const guard=()=>{local.throwIfAborted();if(epoch!==this.#epoch||this.#fault)throw this.#fault??new Error('Print action invalidated by stop');};
  try{guard();await action(local,guard);guard();}finally{this.#actions.delete(controller);}
 }
 prepare(request:Readonly<StartPrint>,signal:AbortSignal):Promise<void>{
  return this.#run(signal,async(local,guard)=>{
   if(this.#job)throw new Error('A print is already prepared');
   const job=Object.freeze({...request});this.#prepared=false;this.#pausedTargets=undefined;this.#job=job;
   await this.#device.prepare(job,local);guard();
   await this.#heaters.setTargets([...this.#extruders.map(name=>({name,target:name===this.#nozzle?job.nozzle:0})),{name:this.#bed,target:job.bed}],local);
   guard();await this.#stable(local);guard();this.#prepared=true;
  });
 }
 async #stable(signal:AbortSignal,targets?:readonly {name:string;target:number}[]):Promise<void>{
  const job=this.#job;if(!job)throw new Error('No prepared print');
  const expected=targets??[...this.#extruders.map(name=>({name,target:name===this.#nozzle?job.nozzle:0})),{name:this.#bed,target:job.bed}];
  const unchanged=()=>{if(expected.some(t=>this.#heaters.getTemperature(t.name).target!==t.target))throw new Error('Print heater targets changed during preparation or resume');};
  unchanged();await Promise.all(expected.filter(t=>t.target!==0).map(t=>this.#heaters.waitUntilStable(t.name,signal)));unchanged();
 }
 start(fileId:string,signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{
  if(!this.#prepared||!this.#job||this.#job.fileId!==fileId)throw new Error('Print file does not match prepared job');guard();await this.#device.start(fileId,local);
 });}
 pause(signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{if(!this.#job||this.#pausedTargets)throw new Error('No running print to pause');await this.#device.pause(local);guard();this.#pausedTargets=Object.freeze([...this.#extruders,this.#bed].map(name=>Object.freeze({name,target:this.#heaters.getTemperature(name).target})));});}
 resume(signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{if(!this.#pausedTargets)throw new Error('No paused heater state');await this.#stable(local,this.#pausedTargets);guard();await this.#device.resume(local);guard();this.#pausedTargets=undefined;});}
 finish(requestId:string,signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{
  if(!this.#job||this.#job.requestId!==requestId)throw new Error('Print completion does not match prepared job');
  await this.#completion(async owned=>{
   guard();owned.throwIfAborted();if(!this.#job||this.#job.requestId!==requestId)throw new Error('Print completion does not match prepared job');
   // Retain admission through EOF validation, native drain, output completion,
   // and both heater-off acknowledgements. Safety stop bypasses admission.
   await this.#device.finish(requestId,owned);guard();owned.throwIfAborted();await this.#heaters.turnOffAll();guard();owned.throwIfAborted();this.#prepared=false;this.#job=undefined;
  },local);
 });}
 stop():Promise<void>{
  if(this.#stopping)return this.#stopping;
  const deferred=Promise.withResolvers<void>();this.#stopping=deferred.promise;this.#epoch++;this.#pausedTargets=undefined;this.#job=undefined;this.#prepared=false;
  for(const controller of this.#actions)controller.abort(new Error('Print device stopped'));
  // Neither operation may prevent the other safety path from being attempted.
  const jobs:Promise<void>[]=[];
  for(const stop of [()=>this.#device.stop(),()=>this.#heaters.turnOffAll()])try{jobs.push(stop());}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{
   const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
   this.#stopping=undefined;
   if(errors.length){const error=new AggregateError(errors,'Motion and heater stop failed');this.#setFault(error);deferred.reject(error);}else deferred.resolve();
  });return deferred.promise;
 }
}
