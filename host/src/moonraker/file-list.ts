import {Worker} from 'node:worker_threads';
import {isAbsolute} from 'node:path';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface FileRoot {name:string;path:string;permissions:'r'|'rw';}
export interface FileListEntry {path:string;modified:number;size:number;permissions:'r'|'rw'|'';}
export interface FileListingOptions {
 roots:readonly {name:string;path:string;writable:boolean}[];
 reserved?:readonly {path:string;canRead:boolean}[];
 maxEntries?:number;maxFiles?:number;maxOutputBytes?:number;maxPending?:number;timeoutMs?:number;
}
interface Pending {cancel:Int32Array;finish:(error:unknown,value?:FileListEntry[])=>void;dispose:()=>void;}
/** Observational filesystem metadata in a dedicated Worker. These listings grant
 * no capability to open or mutate a pathname later; authorization is separate. */
export class FileListing {
 #worker:Worker;#roots:readonly Readonly<FileRoot>[]=[];#pending=new Map<number,Pending>();#next=0;#closed=false;#closing:Promise<void>|undefined;#options:Required<FileListingOptions>;
 private constructor(options:Required<FileListingOptions>){this.#options=options;this.#worker=new Worker(new URL('./file-list-worker.ts',import.meta.url),{workerData:options,execArgv:[]});}
 static async open(input:FileListingOptions):Promise<FileListing>{
  const path=(value:unknown)=>typeof value==='string'&&value.isWellFormed()&&isAbsolute(value)&&!value.includes('\0')&&Buffer.byteLength(value)<=4096;
  if(!input||!Array.isArray(input.roots)||input.roots.length>64||input.roots.some(r=>!r||typeof r.name!=='string'||!(/^[A-Za-z0-9_-]{1,64}$/).test(r.name)||!path(r.path)||typeof r.writable!=='boolean')||new Set(input.roots.map(r=>r.name)).size!==input.roots.length)throw new TypeError('Invalid file roots');
  const reserved=input.reserved??[];if(!Array.isArray(reserved)||reserved.length>256||reserved.some(r=>!r||!path(r.path)||typeof r.canRead!=='boolean'))throw new TypeError('Invalid reserved paths');
  const options:Required<FileListingOptions>=structuredClone({...input,reserved,maxEntries:input.maxEntries??50000,maxFiles:input.maxFiles??10000,maxOutputBytes:input.maxOutputBytes??1024**2,maxPending:input.maxPending??4,timeoutMs:input.timeoutMs??5000});
  for(const [key,max] of [['maxEntries',1000000],['maxFiles',100000],['maxOutputBytes',1024**2],['maxPending',64],['timeoutMs',60000]] as const)if(!Number.isSafeInteger(options[key])||options[key]<1||options[key]>max)throw new RangeError('Invalid file listing capacity');
  const instance=new FileListing(options),ready=Promise.withResolvers<void>();
  const fail=(error:unknown)=>{instance.#closed=true;ready.reject(error);for(const pending of instance.#pending.values()){Atomics.store(pending.cancel,0,1);pending.finish(error);pending.dispose();}instance.#pending.clear();};
  instance.#worker.on('error',fail);instance.#worker.on('exit',()=>fail(new ApiError(503,'File listing worker exited')));
  instance.#worker.on('message',message=>{
   if('ready' in message){if(message.ready){instance.#roots=Object.freeze(message.roots.map((root:FileRoot)=>Object.freeze(root)));ready.resolve();}else ready.reject(new ApiError(500,message.error));return;}
   const pending=instance.#pending.get(message.id);if(!pending)return;instance.#pending.delete(message.id);pending.dispose();pending.finish(message.error?new ApiError(message.error.code,message.error.message):undefined,message.value);
  });
  const timer=setTimeout(()=>ready.reject(new ApiError(504,'File listing startup timed out')),options.timeoutMs);
  try{await ready.promise;return instance;}catch(error){await instance.close();throw error;}finally{clearTimeout(timer);}
 }
 roots():readonly Readonly<FileRoot>[] {if(this.#closed)throw new ApiError(503,'File listing is closed');return this.#roots;}
 get pendingRequests():number{return this.#pending.size;}
 list(root:string,signal:AbortSignal):Promise<FileListEntry[]>{
  if(this.#closed)return Promise.reject(new ApiError(503,'File listing is closed'));
  if(typeof root!=='string'||root.length>128)return Promise.reject(new ApiError(400,'Invalid root argument'));
  if(signal.aborted)return Promise.reject(signal.reason);
  if(this.#pending.size>=this.#options.maxPending||this.#next===Number.MAX_SAFE_INTEGER)return Promise.reject(new ApiError(503,'File listing queue is full'));
  const id=++this.#next,cancel=new Int32Array(new SharedArrayBuffer(4)),result=Promise.withResolvers<FileListEntry[]>();let settled=false;
  const finish=(error:unknown,value?:FileListEntry[])=>{if(settled)return;settled=true;if(error!==undefined)result.reject(error);else result.resolve(value!);};
  // Aborted calls retain their capacity slot until the Worker acknowledges them.
  const abort=()=>{Atomics.store(cancel,0,1);finish(signal.reason??new ApiError(499,'File listing cancelled'));};
  const timer=setTimeout(()=>{Atomics.store(cancel,0,1);finish(new ApiError(504,'File listing timed out'));},this.#options.timeoutMs);
  const dispose=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  this.#pending.set(id,{cancel,finish,dispose});signal.addEventListener('abort',abort,{once:true});
  try{this.#worker.postMessage({id,root,cancel:cancel.buffer});}catch(error){this.#pending.delete(id);dispose();finish(error);}
  return result.promise;
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  for(const pending of this.#pending.values()){Atomics.store(pending.cancel,0,1);pending.finish(new ApiError(503,'File listing is closed'));pending.dispose();}this.#pending.clear();
  this.#closing=this.#worker.terminate().then(()=>{});return this.#closing;
 }
}
export function registerFileListing(registry:EndpointRegistry,files:FileListing):()=>void{
 const detach:(()=>void)[]=[];
 try{
  detach.push(registry.register({endpoint:'/server/files/roots',methods:['GET']},()=>files.roots() as unknown as Json));
  detach.push(registry.register({endpoint:'/server/files/list',methods:['GET']},(params,_verb,context)=>{
   const root=Object.hasOwn(params,'root')?params.root:'gcodes';if(typeof root!=='string')throw new ApiError(400,'Unable to extract argument [root] as string');return files.list(root,context.signal) as unknown as Promise<Json>;
  }));
 }catch(error){for(const remove of detach.reverse())remove();throw error;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const remove of detach.reverse())remove();};
}
