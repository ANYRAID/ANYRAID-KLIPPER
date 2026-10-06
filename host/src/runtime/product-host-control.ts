import {randomUUID} from 'node:crypto';
import {HostRecoveryJournal,recoveryCapacity,type RecoveryRecord,type RecoveryJournalOptions,type RecoveryKind,type MachineRecoveryKind} from './host-recovery-journal.ts';
import type {MachineAction} from '../moonraker/machine-control.ts';
export type HostReloadKind='reinitialize'|RecoveryKind;
type StandardReloadKind='restart'|'firmware_restart';
export const machineRecoveryKinds=['service_start','service_stop','service_restart','server_restart','machine_reboot','machine_shutdown'] as const;
export function recoveryMachineAction(kind:HostReloadKind,service?:string):MachineAction|undefined{
 if(kind==='service_start'||kind==='service_stop'||kind==='service_restart'){if(typeof service!=='string')throw new Error('Missing recovery service');return {kind:'service',action:kind.slice(8) as 'start'|'stop'|'restart',service};}
 if(kind==='server_restart')return {kind};if(kind==='machine_reboot')return {kind:'reboot'};if(kind==='machine_shutdown')return {kind:'shutdown'};
}
export class RestartAdmissionError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
/** One process owner across device generations. Durable receipts never replay. */
export class ProductHostControl {
 #token=randomUUID();#validate:((kind:HostReloadKind,service?:string)=>void)=()=>{};#queuedCancel:(()=>void)|undefined;#remoteBusy=false;
 #kinds=new Set<HostReloadKind>();#generationSignal:AbortSignal|undefined;#pendingKind:HostReloadKind|undefined;
 #standards=new Map<StandardReloadKind,{token:string;id:string;admission:Promise<RecoveryRecord>}>();
 #machines=new Map<MachineRecoveryKind,{token:string;id:string;service?:string;admission:Promise<RecoveryRecord>}>();
 #requests=new Map<string,RecoveryRecord>();#journal:HostRecoveryJournal|undefined;#identity:string|undefined;#configured=false;#storageFault:unknown;#closed=false;#tasks=new Set<Promise<unknown>>();
 #counts=new Map<keyof typeof recoveryCapacity,number>();
 #handler:((kind:HostReloadKind,service?:string)=>Promise<void>)|undefined;#pending:Promise<void>|undefined;#pendingService:string|undefined;
 #count(kind:keyof typeof recoveryCapacity){return this.#counts.get(kind)??0;}
 #latest(kind:StandardReloadKind){const standard=this.#standards.get(kind);return standard?this.operation(standard.id):null;}
 get status(){const open=!!this.#handler&&!this.#closed&&!this.#storageFault;return {state_token:this.#token,available:open&&this.#kinds.has('reinitialize'),restart_available:open&&this.#kinds.has('restart'),restart_operation:this.#latest('restart'),firmware_restart_available:open&&this.#kinds.has('firmware_restart'),firmware_restart_operation:this.#latest('firmware_restart'),machine_control:{available_kinds:open?machineRecoveryKinds.filter(kind=>this.#kinds.has(kind)):[],operations:machineRecoveryKinds.map(kind=>{const request=this.#machines.get(kind);return request?this.operation(request.id):null;}).filter(r=>r!==null)},busy:!!this.#pending||this.#remoteBusy,durable:!!this.#journal,storage_failed:!!this.#storageFault,recovery_history:{controlled:{retained:this.#count('reinitialize'),capacity:recoveryCapacity.reinitialize},standard_restart:{retained:this.#count('restart'),capacity:recoveryCapacity.restart},standard_firmware_restart:{retained:this.#count('firmware_restart'),capacity:recoveryCapacity.firmware_restart}}};}
 operation(id:string){const record=this.#requests.get(id);return record?{...record}:null;}
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
 requestMachineAction(action:MachineAction,generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{
  if(!action||typeof action!=='object'||Array.isArray(action))return Promise.reject(new RestartAdmissionError(409,'Invalid machine action'));
  let kind:MachineRecoveryKind,service:string|undefined;
  if(action.kind==='service'){
   if(Object.keys(action).length!==3||!['start','stop','restart'].includes(action.action)||typeof action.service!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}$/u.test(action.service))return Promise.reject(new RestartAdmissionError(409,'Invalid service action'));
   kind=('service_'+action.action) as MachineRecoveryKind;service=action.service;
  }else{if(Object.keys(action).length!==1||!['server_restart','reboot','shutdown'].includes(action.kind))return Promise.reject(new RestartAdmissionError(409,'Invalid machine action'));kind=action.kind==='server_restart'?'server_restart':action.kind==='reboot'?'machine_reboot':'machine_shutdown';}
  if(this.#generationSignal&&(generationSignal!==this.#generationSignal||generationSignal.aborted&&!retiredAtAdmission))return Promise.reject(new RestartAdmissionError(503,'Machine request belongs to a retired device'));
  const previous=this.#machines.get(kind),record=previous?this.operation(previous.id):null;
  if(previous?.token===this.#token&&previous.service===service&&this.#remoteBusy&&record?.state==='running')return previous.admission;
  if(this.#pending||this.#remoteBusy)return Promise.reject(new RestartAdmissionError(409,'A host operation is already pending'));
  if(!this.#handler||this.#closed||!this.#kinds.has(kind))return Promise.reject(new RestartAdmissionError(503,'Machine control is unavailable'));
  const id='machine-'+randomUUID(),token=this.#token,admission=this.#track(this.#request(id,token,afterResponse,kind,service)),request={id,token,service,admission};this.#machines.set(kind,request);
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
 async #request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void,kind:HostReloadKind='reinitialize',service?:string):Promise<RecoveryRecord>{
  if(this.#closed||this.#storageFault)throw new Error('Recovery journal is unavailable');
  const existing=this.#requests.get(id);if(existing){if(existing.state_token!==token||(existing.kind??'reinitialize')!==kind||existing.service!==service)throw new Error('Reinitialization request identity conflicts');return {...existing};}
  if(kind==='reinitialize'&&(id.startsWith('restart-')||id.startsWith('firmware-restart-')||id.startsWith('machine-')))throw new Error('Standard restart request IDs are reserved');
  if(token!==this.#token)throw new Error('Stale host state token');
  if(!this.#handler)throw new Error('Product host is not ready for reinitialization');
  if(!this.#kinds.has(kind))throw new RestartAdmissionError(503,'Product host does not support this reload in its current state');
  if(this.#pending||this.#remoteBusy)throw new Error('Reinitialization is already pending');
  if(kind==='reinitialize'&&this.#count(kind)>=recoveryCapacity.reinitialize)throw new Error('Reinitialization history capacity exceeded');
  this.#validate(kind,service);this.#remoteBusy=true;
  const record:RecoveryRecord={request_id:id,state_token:token,state:'queued',error:null,...kind!=='reinitialize'?{kind}:{},...service===undefined?{}:{service}};
  try{await this.#save(record);}catch(error){this.#remoteBusy=false;throw error;}
  let settled=false;const finish=(sent:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);this.#queuedCancel=undefined;void this.#track(this.#dispatch(record,sent,kind)).catch(()=>{});};
  const timer=setTimeout(()=>finish(false),10000);timer.unref();this.#queuedCancel=()=>finish(false);
  if(this.#closed||!this.#handler||token!==this.#token){finish(false);throw new Error('Host stopped during recovery admission');}
  try{afterResponse(finish);}catch(error){finish(false);throw error;}
  return {...record};
 }
 async #dispatch(record:RecoveryRecord,sent:boolean,kind:HostReloadKind){
  try{
   if(!sent||this.#closed||record.state_token!==this.#token){await this.#save({...record,state:'failed',error:'Response was not handed off or host generation changed'});return;}
   await this.#save({...record,state:'running'});
   if(this.#closed||record.state_token!==this.#token)throw new Error('Host stopped before recovery');
   await this.#begin(kind,record.service);await this.#save({...record,state:'succeeded',error:null});
  }catch(error){if(!this.#storageFault)await this.#save({...record,state:'failed',error:'Reinitialization failed; inspect host readiness and process error'});}
  finally{this.#remoteBusy=false;}
 }
 attach(handler:(kind:HostReloadKind,service?:string)=>Promise<void>,validate:(kind:HostReloadKind,service?:string)=>void=()=>{},options:{kinds?:readonly HostReloadKind[];generationSignal?:AbortSignal}={}):()=>void{
  if(this.#handler||this.#closed)throw new Error('Product host control already owned or closed');this.#handler=handler;this.#validate=validate;this.#token=randomUUID();this.#kinds=new Set(options.kinds??['reinitialize','restart']);this.#generationSignal=options.generationSignal;
  return ()=>{if(this.#handler===handler){this.#queuedCancel?.();this.#handler=undefined;}};
 }
 reinitialize():Promise<void>{
  if(this.#remoteBusy)return Promise.reject(new Error('Remote reinitialization response is pending'));
  if(this.#storageFault)return Promise.reject(new Error('Recovery journal is unavailable'));
  return this.#begin('reinitialize');
 }
 #begin(kind:HostReloadKind,service?:string):Promise<void>{
  if(this.#pending)return this.#pendingKind===kind&&this.#pendingService===service?this.#pending:Promise.reject(new Error('A different host reload is pending'));
  if(!this.#handler||this.#closed)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  if(!this.#kinds.has(kind))return Promise.reject(new Error('Product host reload is unavailable'));
  let work:Promise<void>;try{this.#validate(kind,service);work=this.#handler(kind,service);}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending){this.#pending=undefined;this.#pendingKind=undefined;this.#pendingService=undefined;}});this.#pending=pending;this.#pendingKind=kind;this.#pendingService=service;return pending;
 }
 async close():Promise<void>{this.#closed=true;this.#queuedCancel?.();while(this.#tasks.size)await Promise.allSettled([...this.#tasks]);await this.#journal?.close();if(this.#storageFault)throw this.#storageFault;}
}
