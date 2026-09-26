import {randomUUID} from 'node:crypto';
import {HostRecoveryJournal,type RecoveryRecord,type RecoveryJournalOptions} from './host-recovery-journal.ts';
/** One process owner across device generations. Durable receipts never replay. */
export class ProductHostControl {
 #token=randomUUID();#validate=()=>{};#queuedCancel:(()=>void)|undefined;#remoteBusy=false;
 #requests=new Map<string,RecoveryRecord>();#journal:HostRecoveryJournal|undefined;#identity:string|undefined;#configured=false;#storageFault:unknown;#closed=false;#tasks=new Set<Promise<unknown>>();
 #handler:(()=>Promise<void>)|undefined;#pending:Promise<void>|undefined;
 get status(){return {state_token:this.#token,available:!!this.#handler&&!this.#closed&&!this.#storageFault,busy:!!this.#pending||this.#remoteBusy,durable:!!this.#journal,storage_failed:!!this.#storageFault};}
 operation(id:string){const record=this.#requests.get(id);return record?{...record}:null;}
 async configure(options?:RecoveryJournalOptions):Promise<void>{
  const identity=options?JSON.stringify(options):undefined;if(this.#configured){if(identity!==this.#identity)throw new Error('Recovery journal identity cannot change during host lifetime');return;}
  if(this.#handler||this.#requests.size||this.#closed)throw new Error('Recovery journal must be configured before host startup');
  if(options){const opened=await HostRecoveryJournal.open(options);this.#journal=opened.journal;this.#requests=new Map(opened.records.map(r=>[r.request_id,r]));}this.#identity=identity;this.#configured=true;
 }
 #track<T>(promise:Promise<T>):Promise<T>{this.#tasks.add(promise);void promise.then(()=>this.#tasks.delete(promise),()=>this.#tasks.delete(promise));return promise;}
 async #save(record:RecoveryRecord){try{const saved=this.#journal?await this.#journal.save(record):record;this.#requests.set(saved.request_id,{...saved});return {...saved};}catch(error){this.#storageFault=error;throw error;}}
 request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{return this.#track(this.#request(id,token,afterResponse));}
 async #request(id:string,token:string,afterResponse:(callback:(sent:boolean)=>void)=>void):Promise<RecoveryRecord>{
  if(this.#closed||this.#storageFault)throw new Error('Recovery journal is unavailable');
  const existing=this.#requests.get(id);if(existing){if(existing.state_token!==token)throw new Error('Reinitialization request identity conflicts');return {...existing};}
  if(token!==this.#token)throw new Error('Stale host state token');
  if(!this.#handler)throw new Error('Product host is not ready for reinitialization');
  if(this.#pending||this.#remoteBusy)throw new Error('Reinitialization is already pending');
  if(this.#requests.size>=128)throw new Error('Reinitialization history capacity exceeded');
  this.#validate();this.#remoteBusy=true;
  const record:RecoveryRecord={request_id:id,state_token:token,state:'queued',error:null};
  try{await this.#save(record);}catch(error){this.#remoteBusy=false;throw error;}
  let settled=false;const finish=(sent:boolean)=>{if(settled)return;settled=true;clearTimeout(timer);this.#queuedCancel=undefined;void this.#track(this.#dispatch(record,sent)).catch(()=>{});};
  const timer=setTimeout(()=>finish(false),10000);timer.unref();this.#queuedCancel=()=>finish(false);
  if(this.#closed||!this.#handler||token!==this.#token){finish(false);throw new Error('Host stopped during recovery admission');}
  try{afterResponse(finish);}catch(error){finish(false);throw error;}
  return {...record};
 }
 async #dispatch(record:RecoveryRecord,sent:boolean){
  try{
   if(!sent||this.#closed||record.state_token!==this.#token){await this.#save({...record,state:'failed',error:'Response was not handed off or host generation changed'});return;}
   await this.#save({...record,state:'running'});
   if(this.#closed||record.state_token!==this.#token)throw new Error('Host stopped before recovery');
   await this.#begin();await this.#save({...record,state:'succeeded',error:null});
  }catch(error){if(!this.#storageFault)await this.#save({...record,state:'failed',error:'Reinitialization failed; inspect host readiness and process error'});}
  finally{this.#remoteBusy=false;}
 }
 attach(handler:()=>Promise<void>,validate:()=>void=()=>{}):()=>void{
  if(this.#handler||this.#closed)throw new Error('Product host control already owned or closed');this.#handler=handler;this.#validate=validate;this.#token=randomUUID();
  return ()=>{if(this.#handler===handler){this.#queuedCancel?.();this.#handler=undefined;}};
 }
 reinitialize():Promise<void>{
  if(this.#remoteBusy)return Promise.reject(new Error('Remote reinitialization response is pending'));
  if(this.#storageFault)return Promise.reject(new Error('Recovery journal is unavailable'));
  return this.#begin();
 }
 #begin():Promise<void>{
  if(this.#pending)return this.#pending;
  if(!this.#handler||this.#closed)return Promise.reject(new Error('Product host is not ready for reinitialization'));
  let work:Promise<void>;try{this.#validate();work=this.#handler();}catch(error){return Promise.reject(error);}
  const pending=work.finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;return pending;
 }
 async close():Promise<void>{this.#closed=true;this.#queuedCancel?.();while(this.#tasks.size)await Promise.allSettled([...this.#tasks]);await this.#journal?.close();if(this.#storageFault)throw this.#storageFault;}
}
