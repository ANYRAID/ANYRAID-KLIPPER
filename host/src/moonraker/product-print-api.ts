import {randomUUID} from 'node:crypto';
import {printFilename} from './print-api.ts';
import {PrintController,type StartPrint} from '../operations/print.ts';
import {journalRequest,validJournalId} from '../operations/print-journal-types.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import type {PressureAdvancePort} from '../gcode/pressure-advance.ts';
import {pressureAdvanceSettings,planPressureAdvance} from '../motion/pressure-advance-settings.ts';
export interface NativePrintCompatibility {
 /** Trusted machine policy: resolve published filename and explicit preparation
  * temperatures. This hook must not move or heat the printer. */
 start(filename:string,signal:AbortSignal):Promise<{fileId:string;nozzle:number;bed:number}>;
}
const owners=new WeakSet<PrintController>();
const details=(request:Readonly<StartPrint>)=>({version:request.version,request_id:request.requestId,file_id:request.fileId,nozzle:request.nozzle,bed:request.bed,...request.expiresAt===undefined?{}:{expires_at:request.expiresAt}});
type Action='start'|'pause'|'resume'|'cancel'|'reset'|'status'|'emergency_stop'|'pressure_advance';
/** Explicit native-mode print owner. HTTP/WS/MQTT authorizers must authorize
 * file_id and controls. File acquisition independently authorizes/seals data. */
export class ProductPrintApi {
 readonly #controller:PrintController;#closed=false;#closing:Promise<void>|undefined;
 readonly #gate:MaintenanceGate;
 readonly #observers=new AbortController();
 readonly #pressure:PressureAdvancePort|undefined;
 readonly #compatibility:NativePrintCompatibility|undefined;readonly #compatPending=new Set<Promise<unknown>>();
 constructor(controller:PrintController,gate:MaintenanceGate,pressure?:PressureAdvancePort,compatibility?:NativePrintCompatibility){
  if(!(controller instanceof PrintController)||!controller.durable||!controller.usesMaintenanceGate(gate)||owners.has(controller))throw new ApiError(400,'Native printing requires an unowned durable controller and shared maintenance gate');
  if(pressure&&(typeof pressure.name!=='string'||!pressure.name||typeof pressure.applyPressureAdvance!=='function'))throw new ApiError(400,'Invalid pressure control binding');
  if(compatibility&&typeof compatibility.start!=='function')throw new ApiError(400,'Invalid native print compatibility policy');this.#compatibility=compatibility?{start:compatibility.start.bind(compatibility)}:undefined;
  this.#controller=controller;this.#gate=gate;this.#pressure=pressure;owners.add(controller);
 }
 get status(){const controller=this.#controller,request=controller.currentRequest;return {mode:'native',standard_print:!!this.#compatibility,pending_compatibility:this.#compatPending.size,state:controller.state,state_token:controller.stateToken,request:request?details(request):null,pending_device_actions:controller.pendingDeviceActions,safe_stop_pending:controller.safeStopPending,failed:controller.failure!==undefined,closed:this.#closed};}
 /** Internal live state view; network authorization remains the server's job. */
 watchState(signal:AbortSignal){if(this.#closed)throw new ApiError(503,'Native print API is closed');return this.#controller.watchState(AbortSignal.any([signal,this.#observers.signal]));}
 async call(action:Action,params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  context.signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native print API is closed');
  if(action==='status'){
   if(Object.keys(params).some(key=>key!=='request_id'))throw new ApiError(400,'Invalid print status query');
   if(params.request_id===undefined)return this.status;
   if(!validJournalId(params.request_id))throw new ApiError(400,'Invalid print request identity');
   const record=await this.#controller.requestRecord(params.request_id);context.signal.throwIfAborted();
   return {current:this.status,record:record?{request:details(record.request),state:record.state,revision:record.revision,...record.statistics?{statistics:{total_duration:record.statistics.totalDuration,print_duration:record.statistics.printDuration,filament_used:record.statistics.filamentUsed}}:{}}:null};
  }
  if(this.#compatibility&&(['start','pause','resume','cancel'].includes(action))&&(action==='start'?Object.hasOwn(params,'filename'):Object.keys(params).length===0))return this.#standard(action as 'start'|'pause'|'resume'|'cancel',params,context);
  let pending:Promise<void>;
  if(action==='emergency_stop'){
   if(Object.keys(params).length)throw new ApiError(400,'Emergency stop does not accept parameters');
   pending=this.#controller.fault(new Error('Remote emergency stop'));
  }else if(action==='start'){
   const allowed=new Set(['version','request_id','file_id','nozzle','bed','expires_at']);let request:StartPrint;
   try{if(Object.keys(params).some(key=>!allowed.has(key))||params.expires_at===undefined)throw new Error();request=journalRequest({version:params.version,requestId:params.request_id,fileId:params.file_id,nozzle:params.nozzle,bed:params.bed,expiresAt:params.expires_at});}catch{throw new ApiError(400,'Native start requires version, request_id, file_id, temperatures and expires_at');}
   pending=this.#controller.admit(request);
  }else if(action==='pressure_advance'){
   const port=this.#pressure;if(!port)throw new ApiError(503,'Native pressure control unavailable');
   if(Object.keys(params).some(key=>!['version','request_id','state_token','extruder','advance','smooth_time'].includes(key))||params.version!==1||params.extruder!==port.name||typeof params.advance!=='number'||typeof params.smooth_time!=='number')throw new ApiError(400,'Pressure control requires version, configured extruder and numeric settings');
   let next;try{next=pressureAdvanceSettings(params.advance,params.smooth_time);}catch{throw new ApiError(400,'Invalid pressure settings');}
   if(typeof params.request_id!=='string'||params.request_id!==this.#controller.currentRequest?.requestId||params.state_token!==this.#controller.stateToken)throw new ApiError(409,'Pressure control requires the current print request and state token');
   pending=this.#controller.adjustPaused(signal=>port.applyPressureAdvance(planPressureAdvance(port.pressureAdvance,next),signal));
  }else{
   if(Object.keys(params).some(key=>key!=='request_id'&&key!=='state_token')||typeof params.request_id!=='string'||!params.request_id||typeof params.state_token!=='string'||params.state_token.length>128)throw new ApiError(400,'Native print control requires request_id and state_token');
   if(this.#controller.currentRequest?.requestId!==params.request_id)throw new ApiError(409,'Print control does not belong to the current request');
   // Synchronous compare and controller transition: no await between them.
   if(params.state_token!==this.#controller.stateToken)throw new ApiError(409,'Print state changed; query the current state before retrying');
   try{if(action==='reset'){this.#controller.reset(params.request_id);pending=Promise.resolve();}else pending=this.#controller[action]();}catch{throw new ApiError(409,'Print state does not allow this action');}
  }
  // Cancellation stops waiting, not an already authorized printer operation.
  // Observe its result even when the client disappears; the controller/journal
  // remain the source of truth and explicit cancel performs safe cleanup.
  await new Promise<void>((resolve,reject)=>{
   const aborted=()=>reject(new ApiError(499,'Print response cancelled; query request state'));
   context.signal.addEventListener('abort',aborted,{once:true});if(context.signal.aborted)aborted();
   void pending.then(resolve,error=>{
    const message=error instanceof Error?error.message:'';
    if(message==='Print request expired before admission')reject(new ApiError(410,message));
    else if(error instanceof RangeError)reject(new ApiError(400,'Invalid print request'));
    else reject(new ApiError(409,'Print request was not completed; query request state'));
   }).finally(()=>context.signal.removeEventListener('abort',aborted));
  });
  return {request_id:params.request_id??null,accepted:true,current:this.status};
 }
 async #standard(action:'start'|'pause'|'resume'|'cancel',params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(this.#compatPending.size>=4)throw new ApiError(429,'Standard print policy capacity exceeded');
  const token=this.#controller.stateToken,state=this.#controller.state,current=this.#controller.currentRequest;
  if(action==='start'&&!['idle','completed','cancelled'].includes(state))throw new ApiError(409,'A print or recovery still owns the device');
  if(action!=='start'&&!current)throw new ApiError(409,'No current print request');
  if(action==='start'&&Object.keys(params).some(key=>key!=='filename'))throw new ApiError(400,'Standard start accepts only filename');
  const filename=action==='start'?printFilename(params.filename):undefined;
  const signal=AbortSignal.any([context.signal,this.#observers.signal,AbortSignal.timeout(30000)]),expiresAt=Date.now()+30000;
  const policy=Promise.resolve().then(async()=>{
   signal.throwIfAborted();let translated:Record<string,Json>;
   if(filename!==undefined){const value=await this.#compatibility!.start(filename,signal);signal.throwIfAborted();let request:StartPrint;try{request=journalRequest({version:1,requestId:'compat-'+randomUUID(),fileId:value.fileId,nozzle:value.nozzle,bed:value.bed,expiresAt});}catch{throw new ApiError(400,'Invalid standard print policy result');}translated={version:1,request_id:request.requestId,file_id:request.fileId,nozzle:request.nozzle,bed:request.bed,expires_at:expiresAt};}
   else translated={request_id:current!.requestId,state_token:token};
   const authorized=authorizedContext({...context,signal},await context.authorize('printer.print.'+action,Object.freeze({...translated,...filename===undefined?{}:{filename}})));signal.throwIfAborted();return {translated,authorized};
  });this.#compatPending.add(policy);void policy.then(()=>this.#compatPending.delete(policy),()=>this.#compatPending.delete(policy));
  const resolved=await new Promise<Awaited<typeof policy>>((resolve,reject)=>{const abort=()=>reject(new ApiError(499,'Standard print policy cancelled; no operation admitted'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();void policy.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
  signal.throwIfAborted();if(this.#closed||this.#controller.stateToken!==token)throw new ApiError(409,'Print state changed during authorization');
  if(action==='start'&&state!=='idle')try{this.#controller.reset(current!.requestId);}catch{throw new ApiError(409,'Previous print cleanup is still pending');}
  await this.call(action,resolved.translated,resolved.authorized);return 'ok';
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#gate.invalidate();this.#observers.abort();const attempt=this.#controller.cancel();this.#closing=attempt;void attempt.catch(()=>{if(this.#closing===attempt)this.#closing=undefined;});return attempt;}
}
export function registerProductPrintApi(registry:EndpointRegistry,api:ProductPrintApi):()=>void{
 const releases:(()=>void)[]=[];try{for(const action of ['start','pause','resume','cancel','reset','status','pressure_advance'] as const)releases.push(registry.register({endpoint:'/printer/print/'+action,methods:[action==='status'?'GET':'POST']},(params,_verb,context)=>api.call(action,params,context)));releases.push(registry.register({endpoint:'/printer/emergency_stop',methods:['POST']},(params,_verb,context)=>api.call('emergency_stop',params,context)));}catch(error){for(const release of releases.reverse())release();throw error;}
 return ()=>{for(const release of releases.splice(0).reverse())release();};
}
