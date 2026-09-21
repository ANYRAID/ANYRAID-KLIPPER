// Moonraker klippy_apis.py print controls, GPL-3.0-or-later.
// Original Copyright (C) 2020 Eric Callahan.
import {MaintenanceBusyError,MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError,type AuthorizedUser,type Json,type RpcContext} from './rpc.ts';
export interface PrintBackend {
 readonly signal:AbortSignal;
 readonly snapshot:{connected:boolean;initialized:boolean;state:string;endpoints:readonly string[]};
 request(method:string,params:Record<string,Json>,options:{signal:AbortSignal}):Promise<Json>;
}
export interface PrintStartEvent {readonly filename:string;readonly user:AuthorizedUser|undefined;}
export interface PrintApiOptions {
 backend():PrintBackend|undefined;
 maintenanceGate:MaintenanceGate;
 /** Observational only. Failure is reported separately and never retries a print. */
 onStartComplete?(event:PrintStartEvent):void|Promise<void>;
}
export function printFilename(value:Json|undefined):string{
 if(typeof value!=='string'||!value.isWellFormed()||!value||Buffer.byteLength(value)>4096||/[\x00-\x1f\x7f]/u.test(value))throw new ApiError(400,'Invalid print filename');
 const name=value.startsWith('/')?value.slice(1):value;
 if(!name||name.startsWith('/')||name.split('/').some(part=>!part||part==='.'||part==='..'))throw new ApiError(400,'Invalid print filename');
 return name;
}
/** Compatibility adapter for a single Klippy generation per request. It does
 * not infer physical completion, retry uncertain commands, or own macro logic. */
export class PrintApi {
 readonly #options:PrintApiOptions;#starting=false;#closed=false;#abort=new AbortController();#observerPending=false;#observerError:string|null=null;
 constructor(options:PrintApiOptions){if(typeof options.backend!=='function'||!(options.maintenanceGate instanceof MaintenanceGate)||options.onStartComplete!==undefined&&typeof options.onStartComplete!=='function')throw new TypeError('Invalid print API owner');this.#options=options;}
 get status(){return {starting:this.#starting,closed:this.#closed,observerError:this.#observerError,observerPending:this.#observerPending};}
 async call(action:'start'|'pause'|'resume'|'cancel',params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(!['start','pause','resume','cancel'].includes(action))throw new ApiError(400,'Invalid print action');
  context.signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Print API is closed');
  const filename=action==='start'?printFilename(params.filename):undefined,backend=this.#options.backend();
  if(!backend||backend.signal.aborted||!backend.snapshot.connected||!backend.snapshot.initialized||backend.snapshot.state!=='ready')throw new ApiError(503,'Klippy is not ready');
  const method=action==='start'?'gcode/script':'pause_resume/'+action;
  if(!backend.snapshot.endpoints.includes(method))throw new ApiError(503,'Klippy print endpoint is unavailable');
  if(action==='start'&&this.#starting)throw new ApiError(409,'A print start request is already pending');
  let release:()=>void;try{release=this.#options.maintenanceGate.activity();}catch(error){if(error instanceof MaintenanceBusyError)throw new ApiError(409,error.message);throw error;}
  if(action==='start')this.#starting=true;
  try{
   const signal=AbortSignal.any([context.signal,backend.signal,this.#abort.signal]);signal.throwIfAborted();
   // Preserve literal backslashes as well as quotes for Klippy's POSIX shlex.
   const args:Record<string,Json>=filename===undefined?{}:{script:'SDCARD_PRINT_FILE FILENAME="'+filename.replace(/\\/g,'\\\\').replace(/"/g,'\\"')+'"'};
   const result=await backend.request(method,args,{signal});signal.throwIfAborted();
   if(filename!==undefined&&this.#options.onStartComplete){
    const event=Object.freeze({filename,user:context.user});
    if(this.#observerPending)this.#observerError='Print observer capacity exceeded';
    else try{const pending=this.#options.onStartComplete(event);if(pending){this.#observerPending=true;void Promise.resolve(pending).catch(error=>{this.#observerError=error instanceof Error?error.message:'Print observer failed';}).finally(()=>{this.#observerPending=false;});}}catch(error){this.#observerError=error instanceof Error?error.message:'Print observer failed';}
   }
   return result;
  }finally{if(action==='start')this.#starting=false;release();}
 }
 close():void{this.#closed=true;this.#abort.abort(new ApiError(503,'Print API is closed'));}
}
export function registerPrintApi(registry:EndpointRegistry,api:PrintApi):()=>void{
 const releases:(()=>void)[]=[];try{for(const action of ['start','pause','resume','cancel'] as const)releases.push(registry.register({endpoint:'/printer/print/'+action,methods:['POST']},(params,_verb,context)=>api.call(action,params,context)));}catch(error){for(const release of releases.reverse())release();throw error;}
 return ()=>{for(const release of releases.splice(0).reverse())release();};
}
