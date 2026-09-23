import type {PrintDevice,StartPrint} from './print.ts';
import {AsyncPrinterHeaters} from '../thermal/async-heaters.ts';
/** The underlying device owns file/EOF validation and motion/output safety.
 * It must not independently set heater targets or replay heater macros. */
export class ThermalPrintDevice implements PrintDevice {
 #listeners=new Set<(cause:unknown)=>void>();
 #device:PrintDevice;#heaters:AsyncPrinterHeaters;#nozzle:string;#bed:string;
 #prepared=false;#job:Readonly<StartPrint>|undefined;#epoch=0;#actions=new Set<AbortController>();
 #stopping:Promise<void>|undefined;#fault:unknown;
 constructor(device:PrintDevice,heaters:AsyncPrinterHeaters,mapping:{nozzle:string;bed:string}){
  for(const method of ['prepare','start','pause','resume','finish','stop'] as const)if(typeof device?.[method]!=='function')throw new TypeError('Incomplete print motion adapter');
  const names=heaters.status.available_heaters.map(name=>name.trim().split(/\s+/).at(-1));
  if(!names.includes(mapping.nozzle)||!names.includes(mapping.bed)||mapping.nozzle===mapping.bed||heaters.status.closed)throw new Error('Invalid print heater mapping');
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
   const job=Object.freeze({...request});this.#job=job;
   await this.#device.prepare(job,local);guard();
   await this.#heaters.setTargets([{name:this.#nozzle,target:job.nozzle},{name:this.#bed,target:job.bed}],local);
   guard();await this.#stable(local);guard();this.#prepared=true;
  });
 }
 async #stable(signal:AbortSignal):Promise<void>{
  const job=this.#job;if(!job)throw new Error('No prepared print');
  const waits=[];if(job.nozzle!==0)waits.push(this.#heaters.waitUntilStable(this.#nozzle,signal));if(job.bed!==0)waits.push(this.#heaters.waitUntilStable(this.#bed,signal));
  await Promise.all(waits);
  if(this.#heaters.getTemperature(this.#nozzle).target!==job.nozzle||this.#heaters.getTemperature(this.#bed).target!==job.bed)throw new Error('Print heater targets changed during preparation or resume');
 }
 start(fileId:string,signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{
  if(!this.#prepared||!this.#job||this.#job.fileId!==fileId)throw new Error('Print file does not match prepared job');guard();await this.#device.start(fileId,local);
 });}
 pause(signal:AbortSignal):Promise<void>{return this.#run(signal,async local=>{if(!this.#job)throw new Error('No prepared print');await this.#device.pause(local);});}
 resume(signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{await this.#stable(local);guard();await this.#device.resume(local);});}
 finish(requestId:string,signal:AbortSignal):Promise<void>{return this.#run(signal,async(local,guard)=>{
  if(!this.#job||this.#job.requestId!==requestId)throw new Error('Print completion does not match prepared job');
  // Underlying finish must verify EOF and drain motion before heating is disabled.
  await this.#device.finish(requestId,local);guard();await this.#heaters.turnOffAll();guard();this.#job=undefined;
 });}
 stop():Promise<void>{
  if(this.#stopping)return this.#stopping;
  const deferred=Promise.withResolvers<void>();this.#stopping=deferred.promise;this.#epoch++;this.#job=undefined;this.#prepared=false;
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
