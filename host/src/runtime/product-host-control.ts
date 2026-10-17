import {MaintenanceGate,type MaintenanceLease} from '../operations/maintenance-gate.ts';
import {validServiceName} from '../moonraker/service-name.ts';
import {SystemBusActionUncertain} from '../moonraker/system-bus-owner.ts';
import {randomUUID} from 'node:crypto';
import {HostRecoveryJournal,recoveryCapacity,type RecoveryRecord,type RecoveryJournalOptions,type RecoveryKind,type MachineRecoveryKind} from './host-recovery-journal.ts';
import {MachineActionUncertain,type MachineAction,type MachineRetirement} from '../moonraker/machine-control.ts';
function uncertainMachineResult(error:unknown):boolean{
 const pending:unknown[]=[error],seen=new Set<Error>();
 while(pending.length&&seen.size<32){const item=pending.pop();if(!(item instanceof Error)||seen.has(item))continue;seen.add(item);if(item instanceof SystemBusActionUncertain||item instanceof MachineActionUncertain)return true;if(item instanceof AggregateError)pending.push(...item.errors.slice(0,32));if(item.cause instanceof Error)pending.push(item.cause);}
 return false;
}
export type HostReloadKind='reinitialize'|RecoveryKind;
type StandardReloadKind='restart'|'firmware_restart';
export const machineRecoveryKinds=['service_start','service_stop','service_restart','server_restart','machine_reboot','machine_shutdown'] as const;
export function recoveryMachineAction(kind:HostReloadKind,service?:string):MachineAction|undefined{
 if(kind==='service_start'||kind==='service_stop'||kind==='service_restart'){if(typeof service!=='string')throw new Error('Missing recovery service');return {kind:'service',action:kind.slice(8) as 'start'|'stop'|'restart',service};}
 if(kind==='server_restart')return {kind};if(kind==='machine_reboot')return {kind:'reboot'};if(kind==='machine_shutdown')return {kind:'shutdown'};
}
export class RestartAdmissionError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
/** Trusted in-process context only; never populated from RPC arguments. */
export interface HostMaintenanceContext {readonly gate:MaintenanceGate;readonly lease:MaintenanceLease;readonly responseHandoff:boolean;}
export type MaintenanceActionFailure='admission'|'response'|'generation'|'action'|'uncertain'|'storage';
export interface MaintenanceActionResult {readonly operation:RecoveryRecord|null;readonly failure:MaintenanceActionFailure|null;readonly lease:MaintenanceLease|undefined;readonly fenced:boolean;}
export interface MaintenanceActionHandle {readonly admission:Promise<RecoveryRecord>;readonly completion:Promise<MaintenanceActionResult>;}
interface OwnedMaintenance extends HostMaintenanceContext {readonly token:string;readonly signal:AbortSignal|undefined;readonly done:ReturnType<typeof Promise.withResolvers<MaintenanceActionResult>>;dispatched:boolean;settled:boolean;id?:string;beforeDispatch?:(record:RecoveryRecord,signal:AbortSignal)=>Promise<void>;readonly associationAbort:AbortController;association?:Promise<void>;}
/** One process owner across device generations. Durable receipts never replay. */
export class ProductHostControl {
 #token=randomUUID();#validate:((kind:HostReloadKind,service?:string,maintenance?:HostMaintenanceContext)=>void)=()=>{};#queuedCancel:(()=>void)|undefined;#remoteBusy=false;
 #kinds=new Set<HostReloadKind>();#generationSignal:AbortSignal|undefined;#pendingKind:HostReloadKind|undefined;
 #standards=new Map<StandardReloadKind,{token:string;id:string;admission:Promise<RecoveryRecord>}>();
 #machines=new Map<MachineRecoveryKind,{token:string;id:string;service?:string;admission:Promise<RecoveryRecord>}>();
 #requests=new Map<string,RecoveryRecord>();#journal:HostRecoveryJournal|undefined;#identity:string|undefined;#configured=false;#storageFault:unknown;#closed=false;#tasks=new Set<Promise<unknown>>();
 #maintenanceGate:MaintenanceGate|undefined;#maintenanceSignal:AbortSignal|undefined;#machineRetirement:((action:MachineAction)=>MachineRetirement)|undefined;
 #counts=new Map<keyof typeof recoveryCapacity,number>();
 #handler:((kind:HostReloadKind,service?:string,maintenance?:HostMaintenanceContext)=>Promise<void>)|undefined;#pending:Promise<void>|undefined;#pendingService:string|undefined;
 #count(kind:keyof typeof recoveryCapacity){return this.#counts.get(kind)??0;}
 #latest(kind:StandardReloadKind){const standard=this.#standards.get(kind);return standard?this.operation(standard.id):null;}
 get status(){const open=!!this.#handler&&!this.#closed&&!this.#storageFault;return {state_token:this.#token,available:open&&this.#kinds.has('reinitialize'),restart_available:open&&this.#kinds.has('restart'),restart_operation:this.#latest('restart'),firmware_restart_available:open&&this.#kinds.has('firmware_restart'),firmware_restart_operation:this.#latest('firmware_restart'),machine_control:{available_kinds:open?machineRecoveryKinds.filter(kind=>this.#kinds.has(kind)):[],operations:machineRecoveryKinds.map(kind=>{const request=this.#machines.get(kind);return request?this.operation(request.id):null;}).filter(r=>r!==null)},busy:!!this.#pending||this.#remoteBusy,durable:!!this.#journal,storage_failed:!!this.#storageFault,recovery_history:{controlled:{retained:this.#count('reinitialize'),capacity:recoveryCapacity.reinitialize},standard_restart:{retained:this.#count('restart'),capacity:recoveryCapacity.restart},standard_firmware_restart:{retained:this.#count('firmware_restart'),capacity:recoveryCapacity.firmware_restart}}};}
 operation(id:string){const record=this.#requests.get(id);return record?{...record}:null;}
 /** Fixed read-only inspection: no dispatch or journal edits. Outstanding
  * association/journal tasks count as active even before a record is visible. */
 inspectMaintenanceRequests(ids:readonly string[]){
  if(this.#closed||this.#storageFault||!this.#journal)throw new RestartAdmissionError(503,'Durable control evidence is unavailable');
  if(this.#pending||this.#remoteBusy||this.#tasks.size)throw new RestartAdmissionError(409,'Control work has not drained');
  if(ids.length>3||ids.some(id=>!/^machine-[a-f0-9-]{36}$/u.test(id)))throw new RestartAdmissionError(409,'Invalid control request identity');
  const records=ids.map(id=>this.operation(id));if(records.some(record=>record&&['queued','running'].includes(record.state)))throw new RestartAdmissionError(409,'Recorded control request is active');
  return {state_token:this.#token,records};
 }
 async configure(options?:RecoveryJournalOptions):Promise<void>{
  const identity=options?JSON.stringify(options):undefined;if(this.#configured){if(identity!==this.#identity)throw new Error('Recovery journal identity cannot change during host lifetime');return;}
  if(this.#handler||this.#requests.size||this.#closed)throw new Error('Recovery journal must be configured before host startup');
  if(options){const opened=await HostRecoveryJournal.open(options);this.#journal=opened.journal;this.#requests=new Map(opened.records.map(r=>[r.request_id,r]));for(const kind of ['restart','firmware_restart'] as const){const latest=opened.records.findLast(r=>r.kind===kind);if(latest)this.#standards.set(kind,{token:latest.state_token,id:latest.request_id,admission:Promise.resolve({...latest})});}for(const kind of machineRecoveryKinds){const latest=opened.records.findLast(r=>r.kind===kind);if(latest)this.#machines.set(kind,{token:latest.state_token,id:latest.request_id,service:latest.service,admission:Promise.resolve({...latest})});}}
  for(const record of this.#requests.values()){const kind=record.kind??"reinitialize";this.#counts.set(kind,this.#count(kind)+1);}
  this.#identity=identity;this.#configured=true;
 }
 #track<T>(promise:Promise<T>):Promise<T>{this.#tasks.add(promise);void promise.then(()=>this.#tasks.delete(promise),()=>this.#tasks.delete(promise));return promise;}
 async #save(record:RecoveryRecord){try{
  let expired:string[]=[];
  if(!this.#journal&&!this.#requests.has(record.request_id)&&record.kind!==undefined&&this.#count(record.kind)>=recoveryCapacity[record.kind]){const oldest=[...this.#requests.values()].find(r=>r.kind===record.kind&&!['queued','running'].includes(r.state));if(!oldest)throw new Error('No completed standard recovery receipt can expire');expired=[oldest.request_id];}
  const written=this.#journal?await this.#journal.save(record):{record,expired};
  for(const id of written.expired){const old=this.#requests.get(id);if(!old)throw new Error('Recovery cache expiration identity missing');const kind=old.kind??'reinitialize';this.#counts.set(kind,this.#count(kind)-1);this.#requests.delete(id);}
  if(!this.#requests.has(written.record.request_id)){const kind=written.record.kind??'reinitialize';this.#counts.set(kind,this.#count(kind)+1);}this.#requests.set(written.record.request_id,{...written.record});return {...written.record};
 }catch(error){this.#storageFault=error;throw error;}}
 request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#track(this.#request(id,token,afterResponse));}
 /** Standard compatibility request: no client token/ID required. Coalesce only
  * within the same device generation; persisted receipts never auto-replay. */
 requestRestart(generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#requestStandard('restart',generationSignal,retiredAtAdmission,afterResponse);}
 requestFirmwareRestart(generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#requestStandard('firmware_restart',generationSignal,retiredAtAdmission,afterResponse);}
 /** Transfers immediately. A synchronous rejection leaves the input lease owned
  * by its caller; after transfer, every outcome settles completion with either a
  * new lease still excluding producers or a permanently closed generation. */
 /** Trusted current-provider planning; aliases reflect the cohosted Node cores. */
 planMaintenanceServices(names:readonly string[]):Array<{aliases:string[];action:MachineAction;retirement:MachineRetirement}>{
  if(!this.#handler||this.#closed||!this.#machineRetirement)throw new RestartAdmissionError(503,'Managed service control is unavailable');
  const external:Array<{aliases:string[];action:MachineAction;retirement:MachineRetirement}>=[];let process:{aliases:string[];action:MachineAction;retirement:MachineRetirement}|undefined;
  for(const name of names){if(!validServiceName(name))throw new RestartAdmissionError(409,'Invalid managed service name');const action:MachineAction=['klipper','moonraker'].includes(name)?{kind:'server_restart'}:{kind:'service',action:'restart',service:name};const retirement=this.#machineRetirement(action);
   if(retirement==='process'){process??={aliases:[],action:{kind:'server_restart'},retirement};process.aliases.push(name);}else external.push({aliases:[name],action,retirement});
  }
  return [...external,...process?[process]:[]];
 }
 requestMaintenanceAction(action:MachineAction,lease:MaintenanceLease,afterResponse?:(callback:(sent:boolean)=>void)=>void,beforeDispatch?:(record:RecoveryRecord,signal:AbortSignal)=>Promise<void>):MaintenanceActionHandle{
  if(!action||action.kind!=='service'&&action.kind!=='server_restart')throw new RestartAdmissionError(409,'Maintenance control supports service or server restart actions only');
  if(action.kind==='server_restart'&&typeof afterResponse!=='function'||afterResponse!==undefined&&typeof afterResponse!=='function')throw new RestartAdmissionError(409,'Server restart requires a real response handoff');
  if(!this.#handler||this.#closed||this.#storageFault||this.#pending||this.#remoteBusy)throw new RestartAdmissionError(409,'Maintenance control is unavailable or busy');
  const gate=this.#maintenanceGate;if(!gate||!gate.owns(lease))throw new RestartAdmissionError(409,'Maintenance lease does not belong to the current host generation');
  const owned:OwnedMaintenance={gate,lease:gate.transfer(lease),token:this.#token,signal:this.#maintenanceSignal,responseHandoff:afterResponse!==undefined,done:Promise.withResolvers<MaintenanceActionResult>(),dispatched:false,settled:false,beforeDispatch,associationAbort:new AbortController()};
  // A retired device may still have a live process maintenance owner. Keep its
  // request identity while the separate maintenance lifetime gates dispatch.
  let admission:Promise<RecoveryRecord>;try{admission=this.#requestMachineAction(action,this.#generationSignal,this.#generationSignal?.aborted,afterResponse,owned);}catch(error){this.#completeMaintenance(owned,'admission');admission=Promise.reject(error);}
  void admission.catch(()=>{if(!owned.dispatched)this.#completeMaintenance(owned,this.#storageFault?'storage':'admission');});
  return Object.freeze({admission,completion:owned.done.promise});
 }
 #completeMaintenance(owned:OwnedMaintenance,failure:MaintenanceActionFailure|null){
  if(owned.settled)return;owned.settled=true;const current=this.#maintenanceGate===owned.gate&&owned.token===this.#token&&!owned.signal?.aborted;
  if(!current)owned.gate.invalidate();const lease=owned.gate.owns(owned.lease)?owned.gate.transfer(owned.lease):undefined;
  if(!lease)owned.lease.release();owned.done.resolve({operation:owned.id?this.operation(owned.id):null,failure,lease,fenced:!lease});
 }
 requestMachineAction(action:MachineAction,generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#requestMachineAction(action,generationSignal,retiredAtAdmission,afterResponse);}
 #requestMachineAction(action:MachineAction,generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:((callback:(sent:boolean)=>void)=>void)|undefined,maintenance?:OwnedMaintenance):Promise<RecoveryRecord>{
  if(!action||typeof action!=='object'||Array.isArray(action))return Promise.reject(new RestartAdmissionError(409,'Invalid machine action'));
  let kind:MachineRecoveryKind,service:string|undefined;
  if(action.kind==='service'){
   if(Object.keys(action).length!==3||!['start','stop','restart'].includes(action.action)||typeof action.service!=='string'||!validServiceName(action.service))return Promise.reject(new RestartAdmissionError(409,'Invalid service action'));
   kind=('service_'+action.action) as MachineRecoveryKind;service=action.service;
  }else{if(Object.keys(action).length!==1||!['server_restart','reboot','shutdown'].includes(action.kind))return Promise.reject(new RestartAdmissionError(409,'Invalid machine action'));kind=action.kind==='server_restart'?'server_restart':action.kind==='reboot'?'machine_reboot':'machine_shutdown';}
  if(this.#generationSignal&&(generationSignal!==this.#generationSignal||generationSignal.aborted&&!retiredAtAdmission))return Promise.reject(new RestartAdmissionError(503,'Machine request belongs to a retired device'));
  const previous=this.#machines.get(kind),record=previous?this.operation(previous.id):null;
  if(previous?.token===this.#token&&previous.service===service&&this.#remoteBusy&&record?.state==='running')return previous.admission;
  if(this.#pending||this.#remoteBusy)return Promise.reject(new RestartAdmissionError(409,'A host operation is already pending'));
  if(!this.#handler||this.#closed||!this.#kinds.has(kind))return Promise.reject(new RestartAdmissionError(503,'Machine control is unavailable'));
  const id='machine-'+randomUUID(),token=this.#token,admission=this.#track(this.#request(id,token,afterResponse,kind,service,maintenance)),request={id,token,service,admission};this.#machines.set(kind,request);
  void admission.catch(()=>{if(this.#machines.get(kind)===request){if(previous)this.#machines.set(kind,previous);else this.#machines.delete(kind);}});return admission;
 }
 #requestStandard(kind:StandardReloadKind,generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{
  if(this.#generationSignal&&(generationSignal!==this.#generationSignal||generationSignal.aborted&&!retiredAtAdmission))return Promise.reject(new RestartAdmissionError(503,'Restart request belongs to a retired device'));
  const previous=this.#standards.get(kind),record=previous?this.operation(previous.id):null;
  if(previous?.token===this.#token&&this.#remoteBusy&&record?.state==='running')return previous.admission;
  if(this.#pending||this.#remoteBusy)return Promise.reject(new RestartAdmissionError(409,'A host reload is already pending'));
  if(!this.#handler||this.#closed||!this.#kinds.has(kind))return Promise.reject(new RestartAdmissionError(503,'Product host restart is unavailable'));
  const id=(kind==='restart'?'restart-':'firmware-restart-')+randomUUID(),token=this.#token,admission=this.#track(this.#request(id,token,afterResponse,kind));
  const standard={id,token,admission};this.#standards.set(kind,standard);
  // An unaccepted request must not hide the last durable restart outcome.
  void admission.catch(()=>{if(this.#standards.get(kind)===standard){if(previous)this.#standards.set(kind,previous);else this.#standards.delete(kind);}});return admission;
 }
 async #request(id:string,token:string,afterResponse:((callback:(sent:boolean)=>void)=>void)|undefined,kind:HostReloadKind='reinitialize',service?:string,maintenance?:OwnedMaintenance):Promise<RecoveryRecord>{
  if(this.#closed||this.#storageFault)throw new Error('Recovery journal is unavailable');
  const existing=this.#requests.get(id);if(existing){if(existing.state_token!==token||(existing.kind??'reinitialize')!==kind||existing.service!==service)throw new Error('Reinitialization request identity conflicts');return {...existing};}
  if(kind==='reinitialize'&&(id.startsWith('restart-')||id.startsWith('firmware-restart-')||id.startsWith('machine-')))throw new Error('Standard restart request IDs are reserved');
  if(token!==this.#token)throw new Error('Stale host state token');
  if(!this.#handler)throw new Error('Product host is not ready for reinitialization');
  if(!this.#kinds.has(kind))throw new RestartAdmissionError(503,'Product host does not support this reload in its current state');
  if(this.#pending||this.#remoteBusy)throw new Error('Reinitialization is already pending');
  if(kind==='reinitialize'&&this.#count(kind)>=recoveryCapacity.reinitialize)throw new Error('Reinitialization history capacity exceeded');
  if(maintenance&&(maintenance.signal?.aborted||maintenance.token!==this.#token||this.#maintenanceGate!==maintenance.gate||!maintenance.gate.owns(maintenance.lease)))throw new RestartAdmissionError(409,'Maintenance ownership changed before admission');
  this.#validate(kind,service,maintenance);this.#remoteBusy=true;
  const record:RecoveryRecord={request_id:id,state_token:token,state:'queued',error:null,...kind!=='reinitialize'?{kind}:{},...service===undefined?{}:{service}};
  if(maintenance)maintenance.id=id;
  try{await this.#save(record);}catch(error){this.#remoteBusy=false;throw error;}
  let settled=false;const finish=(sent:boolean)=>{if(settled)return;settled=true;if(maintenance){maintenance.dispatched=true;if(!sent)maintenance.associationAbort.abort(new Error('Host request expired or response was not handed off'));}clearTimeout(timer);maintenance?.signal?.removeEventListener('abort',retired);this.#queuedCancel=undefined;void this.#track(this.#dispatch(record,sent,kind,maintenance)).catch(()=>{});};
  const timer=setTimeout(()=>finish(false),10000),retired=()=>finish(false);timer.unref();maintenance?.signal?.addEventListener('abort',retired,{once:true});if(maintenance?.signal?.aborted)finish(false);this.#queuedCancel=()=>finish(false);
  if(this.#closed||!this.#handler||token!==this.#token){finish(false);throw new Error('Host stopped during recovery admission');}
  try{if(settled)throw new Error('Host request already expired before dispatch association');if(maintenance?.beforeDispatch){const cancelled=Promise.withResolvers<never>(),abort=()=>cancelled.reject(maintenance.associationAbort.signal.reason);maintenance.associationAbort.signal.addEventListener('abort',abort,{once:true});if(maintenance.associationAbort.signal.aborted)abort();const association=Promise.resolve().then(()=>maintenance.beforeDispatch!({...record},maintenance.associationAbort.signal));maintenance.association=association;this.#track(association);try{await Promise.race([association,cancelled.promise]);}finally{maintenance.associationAbort.signal.removeEventListener('abort',abort);}}if(settled||this.#closed||token!==this.#token||maintenance?.signal?.aborted||maintenance&&!maintenance.gate.owns(maintenance.lease))throw new Error('Host request expired or changed before dispatch association');if(maintenance&&afterResponse===undefined)finish(true);else afterResponse!(finish);}catch(error){finish(false);throw error;}
  return {...record};
 }
 async #dispatch(record:RecoveryRecord,sent:boolean,kind:HostReloadKind,maintenance?:OwnedMaintenance){
  let failure:MaintenanceActionFailure|null=null;try{
   if(!sent||this.#closed||record.state_token!==this.#token||maintenance?.signal?.aborted){failure=!sent?'response':'generation';await this.#save({...record,state:'failed',error:'Response was not handed off or host generation changed'});return;}
   await this.#save({...record,state:'running'});
   if(this.#closed||record.state_token!==this.#token||maintenance?.signal?.aborted)throw new Error('Host stopped before recovery');
   await this.#begin(kind,record.service,maintenance);await this.#save({...record,state:'succeeded',error:null});
  }catch(error){failure=this.#storageFault?'storage':this.#closed||record.state_token!==this.#token||maintenance?.signal?.aborted?'generation':uncertainMachineResult(error)?'uncertain':'action';if(!this.#storageFault)await this.#save({...record,state:uncertainMachineResult(error)?'interrupted':'failed',error:uncertainMachineResult(error)?'System action result is unknown; inspect the daemon and do not replay this request':'Reinitialization failed; inspect host readiness and process error'});}
  finally{if(maintenance?.association)await Promise.allSettled([maintenance.association]);this.#remoteBusy=false;if(maintenance)this.#completeMaintenance(maintenance,this.#storageFault?'storage':failure);}
 }
 attach(handler:(kind:HostReloadKind,service?:string,maintenance?:HostMaintenanceContext)=>Promise<void>,validate:(kind:HostReloadKind,service?:string,maintenance?:HostMaintenanceContext)=>void=()=>{},options:{kinds?:readonly HostReloadKind[];generationSignal?:AbortSignal;maintenanceSignal?:AbortSignal;maintenanceGate?:MaintenanceGate;machineRetirement?:(action:MachineAction)=>MachineRetirement}={}):()=>void{
  if(this.#handler||this.#closed)throw new Error('Product host control already owned or closed');this.#handler=handler;this.#validate=validate;this.#token=randomUUID();this.#kinds=new Set(options.kinds??['reinitialize','restart']);this.#generationSignal=options.generationSignal;this.#maintenanceSignal=options.maintenanceSignal??options.generationSignal;this.#maintenanceGate=options.maintenanceGate;this.#machineRetirement=options.machineRetirement;
  return ()=>{if(this.#handler===handler){this.#queuedCancel?.();this.#handler=undefined;}};
 }
 reinitialize():Promise<void>{
  if(this.#remoteBusy)return Promise.reject(new Error('Remote reinitialization response is pending'));
  if(this.#storageFault)return Promise.reject(new Error('Recovery journal is unavailable'));
  return this.#begin('reinitialize');
 }
 #begin(kind:HostReloadKind,service?:string,maintenance?:OwnedMaintenance):Promise<void>{
  if(this.#pending)return this.#pendingKind===kind&&this.#pendingService===service?this.#pending:Promise.reject(new Error('A different host reload is pending'));
  if(!this.#handler||this.#closed)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  if(!this.#kinds.has(kind))return Promise.reject(new Error('Product host reload is unavailable'));
  let work:Promise<void>;try{if(maintenance&&(maintenance.signal?.aborted||maintenance.token!==this.#token||this.#maintenanceGate!==maintenance.gate||!maintenance.gate.owns(maintenance.lease)))throw new RestartAdmissionError(409,'Maintenance ownership changed before dispatch');this.#validate(kind,service,maintenance);work=this.#handler(kind,service,maintenance);}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending){this.#pending=undefined;this.#pendingKind=undefined;this.#pendingService=undefined;}});this.#pending=pending;this.#pendingKind=kind;this.#pendingService=service;return pending;
 }
 async close():Promise<void>{this.#closed=true;this.#queuedCancel?.();while(this.#tasks.size)await Promise.allSettled([...this.#tasks]);await this.#journal?.close();if(this.#storageFault)throw this.#storageFault;}
}
