import {PrintController,type StartPrint} from '../operations/print.ts';
import {journalRequest,validJournalId} from '../operations/print-journal-types.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {ApiError,type Json,type RpcContext} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
const owners=new WeakSet<PrintController>();
const details=(request:Readonly<StartPrint>)=>({version:request.version,request_id:request.requestId,file_id:request.fileId,nozzle:request.nozzle,bed:request.bed,...request.expiresAt===undefined?{}:{expires_at:request.expiresAt}});
type Action='start'|'pause'|'resume'|'cancel'|'reset'|'status'|'emergency_stop';
/** Explicit native-mode print owner. HTTP/WS/MQTT authorizers must authorize
 * file_id and controls. File acquisition independently authorizes/seals data. */
export class ProductPrintApi {
 readonly #controller:PrintController;#closed=false;#closing:Promise<void>|undefined;
 readonly #gate:MaintenanceGate;
 readonly #observers=new AbortController();
 constructor(controller:PrintController,gate:MaintenanceGate){
  if(!(controller instanceof PrintController)||!controller.durable||!controller.usesMaintenanceGate(gate)||owners.has(controller))throw new ApiError(400,'Native printing requires an unowned durable controller and shared maintenance gate');
  this.#controller=controller;this.#gate=gate;owners.add(controller);
 }
 get status(){const controller=this.#controller,request=controller.currentRequest;return {mode:'native',state:controller.state,state_token:controller.stateToken,request:request?details(request):null,pending_device_actions:controller.pendingDeviceActions,safe_stop_pending:controller.safeStopPending,failed:controller.failure!==undefined,closed:this.#closed};}
 /** Internal live state view; network authorization remains the server's job. */
 watchState(signal:AbortSignal){if(this.#closed)throw new ApiError(503,'Native print API is closed');return this.#controller.watchState(AbortSignal.any([signal,this.#observers.signal]));}
 async call(action:Action,params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  context.signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native print API is closed');
  if(action==='status'){
   if(Object.keys(params).some(key=>key!=='request_id'))throw new ApiError(400,'Invalid print status query');
   if(params.request_id===undefined)return this.status;
   if(!validJournalId(params.request_id))throw new ApiError(400,'Invalid print request identity');
   const record=await this.#controller.requestRecord(params.request_id);context.signal.throwIfAborted();
   return {current:this.status,record:record?{request:details(record.request),state:record.state,revision:record.revision}:null};
  }
  let pending:Promise<void>;
  if(action==='emergency_stop'){
   if(Object.keys(params).length)throw new ApiError(400,'Emergency stop does not accept parameters');
   pending=this.#controller.fault(new Error('Remote emergency stop'));
  }else if(action==='start'){
   const allowed=new Set(['version','request_id','file_id','nozzle','bed','expires_at']);let request:StartPrint;
   try{if(Object.keys(params).some(key=>!allowed.has(key))||params.expires_at===undefined)throw new Error();request=journalRequest({version:params.version,requestId:params.request_id,fileId:params.file_id,nozzle:params.nozzle,bed:params.bed,expiresAt:params.expires_at});}catch{throw new ApiError(400,'Native start requires version, request_id, file_id, temperatures and expires_at');}
   pending=this.#controller.admit(request);
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
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#gate.invalidate();this.#observers.abort();const attempt=this.#controller.cancel();this.#closing=attempt;void attempt.catch(()=>{if(this.#closing===attempt)this.#closing=undefined;});return attempt;}
}
export function registerProductPrintApi(registry:EndpointRegistry,api:ProductPrintApi):()=>void{
 const releases:(()=>void)[]=[];try{for(const action of ['start','pause','resume','cancel','reset','status'] as const)releases.push(registry.register({endpoint:'/printer/print/'+action,methods:[action==='status'?'GET':'POST']},(params,_verb,context)=>api.call(action,params,context)));releases.push(registry.register({endpoint:'/printer/emergency_stop',methods:['POST']},(params,_verb,context)=>api.call('emergency_stop',params,context)));}catch(error){for(const release of releases.reverse())release();throw error;}
 return ()=>{for(const release of releases.splice(0).reverse())release();};
}
