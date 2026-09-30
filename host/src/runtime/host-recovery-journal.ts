import {Worker} from 'node:worker_threads';
import {isAbsolute} from 'node:path';
import {workerEntry} from './worker-entry.ts';
export interface RecoveryRecord {request_id:string;state_token:string;state:'queued'|'running'|'succeeded'|'failed'|'interrupted';error:string|null;kind?:'restart';}
export interface RecoveryWrite {record:RecoveryRecord;expired:string[];}
export const recoveryCapacity={reinitialize:128,restart:64} as const;
export interface RecoveryJournalOptions {path:string;deviceId:string;}
/** Process-lifetime journal; all SQLite work runs off the motion event loop. */
export class HostRecoveryJournal {
 #worker:Worker;#next=0;#pending=new Map<number,{resolve:(value:any)=>void;reject:(error:unknown)=>void}>();#closed=false;#closing:Promise<void>|undefined;#exit:Promise<void>;
 #ready=Promise.withResolvers<RecoveryRecord[]>();
 private constructor(options:RecoveryJournalOptions){
  this.#worker=new Worker(workerEntry('./host-recovery-journal-worker.ts',import.meta.url),{workerData:options,execArgv:[]});
  const fail=(error:unknown)=>{this.#closed=true;this.#ready.reject(error);for(const p of this.#pending.values())p.reject(error);this.#pending.clear();};
  this.#worker.on('message',message=>{if('ready' in message){if(message.ready)this.#ready.resolve(message.records);else this.#ready.reject(new Error(message.error));return;}const pending=this.#pending.get(message.id);if(!pending)return;this.#pending.delete(message.id);if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.value);});
  this.#worker.on('error',fail);this.#exit=new Promise(resolve=>this.#worker.once('exit',()=>{fail(new Error('Recovery journal worker exited'));resolve();}));
 }
 static async open(options:RecoveryJournalOptions){
  if(!isAbsolute(options.path)||options.path.includes('\0')||Buffer.byteLength(options.path)>4096||!/^[A-Za-z0-9_-]{1,128}$/.test(options.deviceId))throw new Error('Invalid recovery journal identity');
  const journal=new HostRecoveryJournal({...options});try{return {journal,records:await journal.#ready.promise};}catch(error){await journal.#worker.terminate();await journal.#exit;throw error;}
 }
 #call(method:string,args:unknown[],closing=false):Promise<any>{
  if(this.#closed||this.#closing&&!closing)return Promise.reject(new Error('Recovery journal closed'));
  if(this.#pending.size>=16&&!closing)return Promise.reject(new Error('Recovery journal capacity exceeded'));
  const id=++this.#next;return new Promise((resolve,reject)=>{this.#pending.set(id,{resolve,reject});try{this.#worker.postMessage({id,method,args});}catch(error){this.#pending.delete(id);reject(error);}});
 }
 /** Expiration and admission commit together; consumers drop cache entries only
  * after this acknowledgement, never before a failed or interrupted write. */
 save(record:RecoveryRecord):Promise<RecoveryWrite>{return this.#call('save',[record]);}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closing=(async()=>{if(!this.#closed)await this.#call('close',[],true);await this.#exit;})();return this.#closing;}
}
