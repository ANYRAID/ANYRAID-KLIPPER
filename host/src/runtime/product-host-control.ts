import {randomUUID} from 'node:crypto';
import {HostRecoveryJournal,recoveryCapacity,type RecoveryRecord,type RecoveryJournalOptions} from './host-recovery-journal.ts';
export type HostReloadKind='reinitialize'|'restart';
export class RestartAdmissionError extends Error {readonly status:409|503;constructor(status:409|503,message:string){super(message);this.status=status;}}
/** One process owner across device generations. Durable receipts never replay. */
export class ProductHostControl {
 #token=randomUUID();#validate:((kind:HostReloadKind)=>void)=()=>{};#queuedCancel:(()=>void)|undefined;#remoteBusy=false;
 #kinds=new Set<HostReloadKind>();#generationSignal:AbortSignal|undefined;#pendingKind:HostReloadKind|undefined;
 #standard:{token:string;id:string;admission:Promise<RecoveryRecord>}|undefined;
 #requests=new Map<string,RecoveryRecord>();#journal:HostRecoveryJournal|undefined;#identity:string|undefined;#configured=false;#storageFault:unknown;#closed=false;#tasks=new Set<Promise<unknown>>();
 #handler:((kind:HostReloadKind)=>Promise<void>)|undefined;#pending:Promise<void>|undefined;
 #count(kind:HostReloadKind){let count=0;for(const r of this.#requests.values())if((r.kind??'reinitialize')===kind)count++;return count;}
 get status(){const open=!!this.#handler&&!this.#closed&&!this.#storageFault;return {state_token:this.#token,available:open&&this.#kinds.has('reinitialize'),restart_available:open&&this.#kinds.has('restart'),restart_operation:this.#standard?this.operation(this.#standard.id):null,busy:!!this.#pending||this.#remoteBusy,durable:!!this.#journal,storage_failed:!!this.#storageFault,recovery_history:{controlled:{retained:this.#count('reinitialize'),capacity:recoveryCapacity.reinitialize},standard_restart:{retained:this.#count('restart'),capacity:recoveryCapacity.restart}}};}
 operation(id:string){const record=this.#requests.get(id);return record?{...record}:null;}
 async configure(options?:RecoveryJournalOptions):Promise<void>{
  const identity=options?JSON.stringify(options):undefined;if(this.#configured){if(identity!==this.#identity)throw new Error('Recovery journal identity cannot change during host lifetime');return;}
  if(this.#handler||this.#requests.size||this.#closed)throw new Error('Recovery journal must be configured before host startup');
  if(options){const opened=await HostRecoveryJournal.open(options);this.#journal=opened.journal;this.#requests=new Map(opened.records.map(r=>[r.request_id,r]));const latest=opened.records.findLast(r=>r.kind==='restart');if(latest)this.#standard={token:latest.state_token,id:latest.request_id,admission:Promise.resolve({...latest})};}this.#identity=identity;this.#configured=true;
 }
 #track<T>(promise:Promise<T>):Promise<T>{this.#tasks.add(promise);void promise.then(()=>this.#tasks.delete(promise),()=>this.#tasks.delete(promise));return promise;}
 async #save(record:RecoveryRecord){try{
  let expired:string[]=[];
  if(!this.#journal&&!this.#requests.has(record.request_id)&&record.kind==='restart'&&this.#count('restart')>=recoveryCapacity.restart){const oldest=[...this.#requests.values()].find(r=>r.kind==='restart'&&!['queued','running'].includes(r.state));if(!oldest)throw new Error('No completed standard recovery receipt can expire');expired=[oldest.request_id];}
  const written=this.#journal?await this.#journal.save(record):{record,expired};
  for(const id of written.expired)this.#requests.delete(id);this.#requests.set(written.record.request_id,{...written.record});return {...written.record};
 }catch(error){this.#storageFault=error;throw error;}}
 request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#track(this.#request(id,token,afterResponse));}
 /** Standard compatibility request: no client token/ID required. Coalesce only
  * within the same device generation; persisted receipts never auto-replay. */
 requestRestart(generationSignal:AbortSignal|undefined,retiredAtAdmission:boolean|undefined,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{
  if(this.#generationSignal&&(generationSignal!==this.#generationSignal||generationSignal.aborted&&!retiredAtAdmission))return Promise.reject(new RestartAdmissionError(503,'Restart request belongs to a retired device'));
  const previous=this.#standard,record=previous?this.operation(previous.id):null;
  if(previous?.token===this.#token&&this.#remoteBusy&&record?.state==='running')return previous.admission;
  if(this.#pending||this.#remoteBusy)return Promise.reject(new RestartAdmissionError(409,'A host reload is already pending'));
  if(!this.#handler||this.#closed||!this.#kinds.has('restart'))return Promise.reject(new RestartAdmissionError(503,'Product host restart is unavailable'));
  const id='restart-'+randomUUID(),token=this.#token,admission=this.#track(this.#request(id,token,afterResponse,'restart'));
  const standard={id,token,admission};this.#standard=standard;
  // An unaccepted request must not hide the last durable restart outcome.
  void admission.catch(()=>{if(this.#standard===standard)this.#standard=previous;});return admission;
 }
 async #request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void,kind:HostReloadKind='reinitialize'):Promise<RecoveryRecord>{
  if(this.#closed||this.#storageFault)throw new Error('Recovery journal is unavailable');
  const existing=this.#requests.get(id);if(existing){if(existing.state_token!==token||(existing.kind??'reinitialize')!==kind)throw new Error('Reinitialization request identity conflicts');return {...existing};}
  if(kind==='reinitialize'&&id.startsWith('restart-'))throw new Error('Standard restart request IDs are reserved');
  if(token!==this.#token)throw new Error('Stale host state token');
  if(!this.#handler)throw new Error('Product host is not ready for reinitialization');
  if(!this.#kinds.has(kind))throw new RestartAdmissionError(503,'Product host does not support this reload in its current state');
  if(this.#pending||this.#remoteBusy)throw new Error('Reinitialization is already pending');
  if(kind==='reinitialize'&&this.#count(kind)>=recoveryCapacity.reinitialize)throw new Error('Reinitialization history capacity exceeded');
  this.#validate(kind);this.#remoteBusy=true;
  const record:RecoveryRecord={request_id:id,state_token:token,state:'queued',error:null,...kind==='restart'?{kind:'restart' as const}:{}};
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
   await this.#begin(kind);await this.#save({...record,state:'succeeded',error:null});
  }catch(error){if(!this.#storageFault)await this.#save({...record,state:'failed',error:'Reinitialization failed; inspect host readiness and process error'});}
  finally{this.#remoteBusy=false;}
 }
 attach(handler:(kind:HostReloadKind)=>Promise<void>,validate:(kind:HostReloadKind)=>void=()=>{},options:{kinds?:readonly HostReloadKind[];generationSignal?:AbortSignal}={}):()=>void{
  if(this.#handler||this.#closed)throw new Error('Product host control already owned or closed');this.#handler=handler;this.#validate=validate;this.#token=randomUUID();this.#kinds=new Set(options.kinds??['reinitialize','restart']);this.#generationSignal=options.generationSignal;
  return ()=>{if(this.#handler===handler){this.#queuedCancel?.();this.#handler=undefined;}};
 }
 reinitialize():Promise<void>{
  if(this.#remoteBusy)return Promise.reject(new Error('Remote reinitialization response is pending'));
  if(this.#storageFault)return Promise.reject(new Error('Recovery journal is unavailable'));
  return this.#begin('reinitialize');
 }
 #begin(kind:HostReloadKind):Promise<void>{
  if(this.#pending)return this.#pendingKind===kind?this.#pending:Promise.reject(new Error('A different host reload is pending'));
  if(!this.#handler||this.#closed)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  if(!this.#kinds.has(kind))return Promise.reject(new Error('Product host reload is unavailable'));
  let work:Promise<void>;try{this.#validate(kind);work=this.#handler(kind);}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending){this.#pending=undefined;this.#pendingKind=undefined;}});this.#pending=pending;this.#pendingKind=kind;return pending;
 }
 async close():Promise<void>{this.#closed=true;this.#queuedCancel?.();while(this.#tasks.size)await Promise.allSettled([...this.#tasks]);await this.#journal?.close();if(this.#storageFault)throw this.#storageFault;}
}
