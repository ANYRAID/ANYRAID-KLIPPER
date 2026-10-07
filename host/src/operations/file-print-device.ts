import type {PrintDevice,StartPrint} from './print.ts';
import {GCodeDispatch} from '../gcode/dispatch.ts';
import {GCodeFileReader} from '../gcode/file-reader.ts';
import {GCodeFileExecution,type FileAdmissionPause} from '../gcode/file-execution.ts';
export interface FilePrintMotion {
 prepare(request:Readonly<StartPrint>,signal:AbortSignal):Promise<void>;
 start(signal:AbortSignal):Promise<void>;
 pause(signal:AbortSignal):Promise<void>;
 /** Stop an active checkpoint while retaining its dispatch ownership. Must not
  * enqueue G-code. resume must release this retained motion before returning. */
 pauseCheckpoint?(signal:AbortSignal):Promise<void>;
 resume(signal:AbortSignal):Promise<void>;
 /** Drain all admitted motion and acknowledge final non-thermal safe outputs. */
 finish(requestId:string,signal:AbortSignal):Promise<void>;
 stop():Promise<void>;
 subscribeFault?(listener:(cause:unknown)=>void):()=>void;
}
/** File acquisition must authorize fileId and return a sealed, fresh reader.
 * Motion owns dispatch readiness and safety. ThermalPrintDevice wraps this class. */
export class FilePrintDevice implements PrintDevice {
 #motion:FilePrintMotion;#dispatch:GCodeDispatch;#open:(fileId:string,signal:AbortSignal)=>Promise<GCodeFileReader>;
 #job:Readonly<StartPrint>|undefined;#execution:GCodeFileExecution|undefined;#epoch=0;
 #stopping:Promise<void>|undefined;#fault:unknown;#started=false;#prepared=false;
 #admission:FileAdmissionPause|undefined;
 /** Bind once while idle; the generation owns and retires this policy. */
 bindAdmissionPause(policy:FileAdmissionPause):()=>void{
  if(this.#admission||this.#job||this.#execution||this.#stopping||this.#fault||!policy||['continue','accepted','blocked'].some(key=>typeof policy[key as keyof FileAdmissionPause]!=='function'))throw new Error('File admission pause owner unavailable');
  this.#admission=policy;return ()=>{if(this.#admission===policy)this.#admission=undefined;};
 }
 #faultListeners=new Set<(cause:unknown)=>void>();#eofListeners=new Set<(requestId:string)=>void>();
 constructor(motion:FilePrintMotion,dispatch:GCodeDispatch,open:(fileId:string,signal:AbortSignal)=>Promise<GCodeFileReader>){
  for(const name of ['prepare','start','pause','resume','finish','stop'] as const)if(typeof motion?.[name]!=='function')throw new TypeError('Incomplete file motion adapter');
  if(motion.pauseCheckpoint!==undefined&&typeof motion.pauseCheckpoint!=='function')throw new TypeError('Invalid file checkpoint pause adapter');
  if(typeof open!=='function')throw new TypeError('Missing authorized file acquisition');this.#motion=motion;this.#dispatch=dispatch;this.#open=open;
  motion.subscribeFault?.(cause=>this.#fail(cause));
 }
 get status(){return {requestId:this.#job?.requestId,file:this.#execution?.status,stopping:this.#stopping!==undefined,fault:this.#fault};}
 get objectStatus(){const execution=this.#execution;if(!execution||this.#stopping||['stopping','stopped'].includes(execution.status.phase))return {progress:0,is_active:false,file_position:0,file_size:0};return execution.objectStatus;}
 subscribeEOF(listener:(requestId:string)=>void):()=>void{
  if(typeof listener!=='function'||this.#eofListeners.has(listener)||this.#eofListeners.size>=64)throw new Error('Invalid file EOF subscription');this.#eofListeners.add(listener);return ()=>{this.#eofListeners.delete(listener);};
 }
 subscribeFault(listener:(cause:unknown)=>void):()=>void{
  if(typeof listener!=='function'||this.#faultListeners.has(listener)||this.#faultListeners.size>=64)throw new Error('Invalid file fault subscription');
  if(this.#fault){listener(this.#fault);return ()=>{};}this.#faultListeners.add(listener);return ()=>{this.#faultListeners.delete(listener);};
 }
 #fail(cause:unknown):void{
  if(this.#fault)return;this.#fault=cause;void this.stop().catch(()=>{});
  const listeners=[...this.#faultListeners];this.#faultListeners.clear();const errors:unknown[]=[];
  for(const listener of listeners)try{listener(cause);}catch(error){errors.push(error);}
  if(errors.length)this.#fault=new AggregateError([cause,...errors],'File print fault observers failed',{cause});
 }
 #guard(signal:AbortSignal,epoch=this.#epoch):void{signal.throwIfAborted();if(epoch!==this.#epoch||this.#stopping||this.#fault)throw this.#fault??new Error('File print action invalidated');}
 async prepare(request:Readonly<StartPrint>,signal:AbortSignal):Promise<void>{
  this.#guard(signal);if(this.#job)throw new Error('File print is already prepared');
  const job=Object.freeze({...request}),epoch=this.#epoch;this.#job=job;this.#execution=undefined;this.#started=false;this.#prepared=false;
  const reader=await this.#open(job.fileId,signal);
  try{this.#guard(signal,epoch);this.#execution=new GCodeFileExecution(reader,this.#dispatch,this.#admission);}
  catch(error){try{await reader.close();}catch(closeError){throw new AggregateError([error,closeError],'File acquisition cleanup failed',{cause:error});}throw error;}
  await this.#motion.prepare(job,signal);this.#guard(signal,epoch);this.#prepared=true;
 }
 async start(fileId:string,signal:AbortSignal):Promise<void>{
  this.#guard(signal);if(!this.#prepared||!this.#execution||!this.#job||this.#job.fileId!==fileId||this.#started)throw new Error('File does not match prepared print');
  const epoch=this.#epoch,job=this.#job,execution=this.#execution;this.#started=true;
  await this.#motion.start(signal);this.#guard(signal,epoch);
  void execution.start().then(()=>{
   if(epoch!==this.#epoch||this.#fault)return;
   for(const listener of [...this.#eofListeners])try{listener(job.requestId);}catch(error){this.#fail(error);break;}
  },error=>{if(epoch===this.#epoch)this.#fail(error);});
 }
 async pause(signal:AbortSignal):Promise<void>{
  this.#guard(signal);const epoch=this.#epoch,execution=this.#execution;if(!execution||!this.#started)throw new Error('No active file print');
  if(execution.status.phase!=='eof')await execution.pause(this.#motion.pauseCheckpoint?()=>this.#motion.pauseCheckpoint!(signal):undefined);this.#guard(signal,epoch);
  if(!execution.status.checkpointHeld)await this.#motion.pause(signal);this.#guard(signal,epoch);
 }
 async resume(signal:AbortSignal):Promise<void>{
  this.#guard(signal);const epoch=this.#epoch,execution=this.#execution;if(!execution||!this.#started)throw new Error('No active file print');
  await this.#motion.resume(signal);this.#guard(signal,epoch);if(execution.status.phase!=='eof')execution.resume();
 }
 async finish(requestId:string,signal:AbortSignal):Promise<void>{
  this.#guard(signal);if(this.#job?.requestId!==requestId||this.#execution?.status.phase!=='eof')throw new Error('File EOF does not match print completion');
  const epoch=this.#epoch;await this.#motion.finish(requestId,signal);this.#guard(signal,epoch);this.#job=undefined;
 }
 stop():Promise<void>{
  if(this.#stopping)return this.#stopping;
  const deferred=Promise.withResolvers<void>();this.#stopping=deferred.promise;this.#epoch++;this.#job=undefined;this.#started=false;
  const jobs:Promise<void>[]=[];for(const stop of [()=>this.#execution?.stop()??Promise.resolve(),()=>this.#motion.stop()])try{jobs.push(stop());}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{
   const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
   if(errors.length){const error=new AggregateError(errors,'File and motion stop failed');this.#fail(error);this.#stopping=undefined;deferred.reject(error);}else{this.#stopping=undefined;deferred.resolve();}
  });return deferred.promise;
 }
}
