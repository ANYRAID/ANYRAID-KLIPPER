import {databaseBackupName} from './database-maintenance.ts';
import {Worker} from 'node:worker_threads';
import {isAbsolute} from 'node:path';
import {lstat} from 'node:fs/promises';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {databaseNamespace,databaseKey,databaseBatchKeys,type DatabaseKey} from './database-record.ts';
import type {DatabaseOptions} from './database-engine.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface DatabaseStoreOptions extends DatabaseOptions {backupDirectory?:string;maxPending?:number;maxPendingBytes?:number;}
type ResolvedDatabaseOptions=Required<Omit<DatabaseStoreOptions,'backupDirectory'>>&{backupDirectory?:string};
interface Pending {resolve(value:Json):void;reject(error:unknown):void;bytes:number;}
/** FIFO durable operations. Accepted writes are never retried or cancelled:
 * caller disconnect does not prove that a transaction failed to commit. */
export class DatabaseStore {
 readonly #worker:Worker;readonly #options:ResolvedDatabaseOptions;readonly #pending=new Map<number,Pending>();readonly #ready:Promise<void>;readonly #exited:Promise<void>;
 #bytes=0;#next=0;#closed=false;#closing:Promise<void>|undefined;
 private constructor(options:ResolvedDatabaseOptions){
  this.#options=options;this.#worker=new Worker(new URL('./database-worker.ts',import.meta.url),{workerData:options,execArgv:[]});
  let ready!:()=>void,failed!:(e:unknown)=>void;this.#ready=new Promise((resolve,reject)=>{ready=resolve;failed=reject;});
  const fail=(e:unknown)=>{this.#closed=true;failed(e);for(const pending of this.#pending.values())pending.reject(e);this.#pending.clear();this.#bytes=0;};
  this.#worker.on('message',message=>{if('ready' in message){if(message.ready)ready();else failed(new ApiError(message.error.status,message.error.message,message.error.data));return;}const pending=this.#pending.get(message.id);if(!pending)return;this.#pending.delete(message.id);this.#bytes-=pending.bytes;if(message.error)pending.reject(new ApiError(message.error.status,message.error.message));else pending.resolve(message.value);});
  this.#worker.on('error',()=>fail(new ApiError(503,'Database worker failed')));this.#exited=new Promise(resolve=>this.#worker.once('exit',()=>{fail(new ApiError(503,'Database worker exited'));resolve();}));
 }
 static async open(options:DatabaseStoreOptions):Promise<DatabaseStore>{
  if(!options||typeof options.path!=='string'||!isAbsolute(options.path)||options.path.includes('\0')||Buffer.byteLength(options.path)>4096)throw new ApiError(400,'Invalid database path');
  if(options.backupDirectory!==undefined&&(!isAbsolute(options.backupDirectory)||options.backupDirectory.includes('\0')))throw new ApiError(400,'Invalid backup directory');
  const limits={maxRecordBytes:options.maxRecordBytes??1024*1024,maxDatabaseBytes:options.maxDatabaseBytes??256*1024*1024,maxReplyBytes:options.maxReplyBytes??8*1024*1024,maxPending:options.maxPending??64,maxPendingBytes:options.maxPendingBytes??8*1024*1024};
  for(const [name,value] of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>(name==='maxPending'?1024:name==='maxDatabaseBytes'?2**32:64*1024*1024))throw new ApiError(400,'Invalid database limits');
  if(limits.maxDatabaseBytes<65536)throw new ApiError(400,'Database capacity too small');
  try{if(!(await lstat(options.path)).isFile())throw new ApiError(400,'Database path must be a regular file');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const owner=new DatabaseStore({...options,...limits});try{await owner.#ready;return owner;}catch(error){await owner.#worker.terminate();await owner.#exited;throw error;}
 }
 get status(){return {closed:this.#closed,closing:!!this.#closing,pending:this.#pending.size,pendingBytes:this.#bytes};}
 #call(method:string,args:Json[],closing=false):Promise<Json>{
  try{
   if(this.#closed||this.#closing&&!closing)throw new ApiError(503,'Database is closed');validateJson(args);
   const bytes=Buffer.byteLength(JSON.stringify(args));if(!closing&&(this.#pending.size>=this.#options.maxPending||this.#bytes+bytes>this.#options.maxPendingBytes))throw new ApiError(429,'Database request queue is full');if(!closing&&this.#next>=Number.MAX_SAFE_INTEGER)throw new ApiError(503,'Database request IDs exhausted');
   const id=closing?0:++this.#next;return new Promise((resolve,reject)=>{this.#pending.set(id,{resolve,reject,bytes});this.#bytes+=bytes;try{this.#worker.postMessage({id,method,args});}catch(error){this.#pending.delete(id);this.#bytes-=bytes;reject(error);}});
  }catch(error){return Promise.reject(error);}
 }
 get(namespace:string,key?:DatabaseKey|null){databaseNamespace(namespace);if(key!==undefined&&key!==null)databaseKey(key);return this.#call('get',[namespace,key as Json??null]);}
 insert(namespace:string,key:DatabaseKey,value:Json){databaseNamespace(namespace);databaseKey(key);return this.#call('insert',[namespace,key as Json,value]);}
 update(namespace:string,key:DatabaseKey,value:Json){databaseNamespace(namespace);databaseKey(key);return this.#call('update',[namespace,key as Json,value]);}
 insertBatch(namespace:string,records:Record<string,Json>){databaseNamespace(namespace);databaseBatchKeys(Object.keys(records));return this.#call('insert-batch',[namespace,records]);}
 getBatch(namespace:string,keys:readonly string[]){databaseNamespace(namespace);databaseBatchKeys(keys);return this.#call('get-batch',[namespace,keys as Json]);}
 deleteBatch(namespace:string,keys:readonly string[]){databaseNamespace(namespace);databaseBatchKeys(keys);return this.#call('delete-batch',[namespace,keys as Json]);}
 moveBatch(namespace:string,sources:readonly string[],destinations:readonly string[]){databaseNamespace(namespace);databaseBatchKeys(sources);databaseBatchKeys(destinations);return this.#call('move-batch',[namespace,sources as Json,destinations as Json]);}
 delete(namespace:string,key:DatabaseKey){databaseNamespace(namespace);databaseKey(key);return this.#call('delete',[namespace,key as Json]);}
 backup(filename:string){return this.#call('backup',[databaseBackupName(filename)]);}
 deleteBackup(filename:string){return this.#call('delete-backup',[databaseBackupName(filename)]);}
 compact(){return this.#call('compact',[]);}
 list(){return this.#call('api-list',[]);}
 api(verb:'GET'|'POST'|'DELETE',namespace:string,key:Json|undefined,value?:Json){databaseNamespace(namespace);if(verb!=='GET'||key!==undefined&&key!==null)databaseKey(key);if(verb==='POST'&&value===undefined)throw new ApiError(400,'Missing database value');return this.#call(verb==='GET'?'api-get':verb==='POST'?'api-insert':'api-delete',[namespace,key??null,value??null]);}
 close():Promise<void>{return this.#closing??=this.#close();}
 async #close(){try{if(!this.#closed)await this.#call('close',[],true);}catch(error){await this.#worker.terminate();throw error;}finally{await this.#exited;}}
}
export function registerDatabase(registry:EndpointRegistry,store:DatabaseStore):()=>void{
 const list=registry.register({endpoint:'/server/database/list',methods:['GET']},()=>store.list());let item:()=>void;
 try{item=registry.register({endpoint:'/server/database/item',methods:['GET','POST','DELETE']},(params,verb)=>store.api(verb,params.namespace as string,params.key,params.value));}catch(error){list();throw error;}
 return ()=>{item();list();};
}
