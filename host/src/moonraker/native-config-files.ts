import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {basename,isAbsolute,resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {FileListing,type FileListingOptions} from './file-list.ts';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import {createSealedBinaryReader} from '../gcode/sealed-file.ts';
import {PrintSnapshotBudget,defaultPrintSnapshotBudget} from '../gcode/snapshot-budget.ts';

export interface NativeConfigFilesOptions {
 root:string;
 /** Relative paths excluded from reads; reserved directory descendants included. */
 reserved?:readonly string[];
 maxFileBytes?:number;maxDownloads?:number;
 listing?:Pick<FileListingOptions,'maxEntries'|'maxFiles'|'maxOutputBytes'|'maxPending'|'timeoutMs'>;
}
type ConfigDownload={record:{id:string;name:string};reader:Awaited<ReturnType<typeof createSealedBinaryReader>>['reader'];size:number;sha256:string};
/** Explicit process-owned read capability. Client paths never leave the pinned
 * root descriptor; snapshots remain immutable even if configuration is edited. */
export class NativeConfigFiles {
 readonly #root:FileHandle;readonly #listing:FileListing;readonly #reserved:readonly string[];
 readonly #max:number;readonly #capacity:number;readonly #budget:PrintSnapshotBudget;
 readonly #stop=new AbortController();readonly #pending=new Set<Promise<unknown>>();#closing:Promise<void>|undefined;
 private constructor(root:FileHandle,listing:FileListing,reserved:readonly string[],max:number,capacity:number){this.#root=root;this.#listing=listing;this.#reserved=reserved;this.#max=max;this.#capacity=capacity;const page=defaultPrintSnapshotBudget.status.pageBytes;this.#budget=new PrintSnapshotBudget({maxSnapshots:capacity,maxBytes:Math.ceil(max/page)*page*capacity});}
 static async open(options:NativeConfigFilesOptions):Promise<NativeConfigFiles>{
  const max=options?.maxFileBytes??4*1024**2,capacity=options?.maxDownloads??2;
  if(!options||typeof options.root!=='string'||!isAbsolute(options.root)||!options.root.isWellFormed()||/[\0\r\n]/u.test(options.root)||Buffer.byteLength(options.root)>4096||resolve(options.root)==='/'||!Number.isSafeInteger(max)||max<1||max>16*1024**2||!Number.isSafeInteger(capacity)||capacity<1||capacity>4)throw new TypeError('Invalid native config root or limits');
  const reserved=options.reserved??[];
  if(!Array.isArray(reserved)||reserved.length>256)throw new TypeError('Invalid config reserved paths');
  for(const path of reserved)NativeConfigFiles.#name(path);
  const path=resolve(options.root),root=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const listing=await FileListing.open({...options.listing,confined:true,roots:[{name:'config',path,writable:false,descriptor:root.fd}],reserved:reserved.map(name=>({path:resolve(path,name),canRead:false}))});return new NativeConfigFiles(root,listing,[...reserved],max,capacity);}
  catch(error){await root.close();throw error;}
 }
 static #name(value:unknown):asserts value is string{
  if(typeof value!=='string'||!value||!value.isWellFormed()||Buffer.byteLength(value)>4096||/[\\\0-\x1f\x7f]/u.test(value)||isAbsolute(value)||value.split('/').some(part=>!part||part==='.'||part==='..')||value.split('/').length>64)throw new ApiError(400,'Invalid config path');
 }
 get status(){return {closed:this.#stop.signal.aborted,pending:this.#pending.size,listings:this.#listing.pendingRequests,snapshots:this.#budget.status};}
 root(){this.#stop.signal.throwIfAborted();return {...this.#listing.roots()[0]!};}
 contains(path:string):boolean{const name=relative(this.root().path,resolve(path));return name!==''&&!isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep);}
 #allowed(name:string){NativeConfigFiles.#name(name);if(name.split('/').includes('.git')||this.#reserved.some(path=>name===path||name.startsWith(path+'/')))throw new ApiError(403,'Reserved config path');}
 async list(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  if(Object.keys(params).some(key=>key!=='root')||params.root!=='config')throw new ApiError(400,'Expected config root');this.#stop.signal.throwIfAborted();
  return await this.#listing.list('config',AbortSignal.any([signal,this.#stop.signal])) as unknown as Json;
 }
 async directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  if(Object.keys(params).some(key=>!['path','extended'].includes(key))||typeof params.path!=='string')throw new ApiError(400,'Expected config directory');
  const value=params.path.replace(/^\/|\/$/g,''),name=value==='config'?'':value.startsWith('config/')?value.slice(7):undefined;
  if(name===undefined)throw new ApiError(400,'Invalid config root');if(name)this.#allowed(name);
  const extended=params.extended??false;if(typeof extended!=='boolean'&&(typeof extended!=='string'||!['true','false'].includes(extended.toLowerCase())))throw new ApiError(400,'Invalid extended flag');
  this.#stop.signal.throwIfAborted();return (await this.#listing.directory(value,AbortSignal.any([signal,this.#stop.signal]))).result as unknown as Json;
 }
 matchesDownload(path:string):boolean{return path.startsWith('/server/files/config/');}
 async #source(name:string,signal:AbortSignal):Promise<FileHandle>{
  let parent=this.#root,owned:FileHandle|undefined;
  try{const parts=name.split('/');for(let i=0;i<parts.length;i++){
   signal.throwIfAborted();const next=await open(`/proc/self/fd/${parent.fd}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(i<parts.length-1?constants.O_DIRECTORY:0));
   try{await owned?.close();}catch(error){await next.close();throw error;}parent=owned=next;
  }const stat=await owned!.stat();signal.throwIfAborted();if(!stat.isFile())throw new ApiError(404,'Config source is not a regular file');const file=owned!;owned=undefined;return file;
  }catch(error){if(['ENOENT','ENOTDIR','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))throw new ApiError(404,'Config file unavailable or symlink forbidden');throw error;}finally{await owned?.close();}
 }
 download(path:string,context:RpcContext,use:(file:ConfigDownload,signal:AbortSignal)=>Promise<void>):Promise<void>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Config files closed'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Config download capacity exceeded'));
  const signal=AbortSignal.any([context.signal,this.#stop.signal]);
  const task=Promise.resolve().then(async()=>{
   signal.throwIfAborted();let name:string;try{name=decodeURIComponent(path.slice('/server/files/config/'.length));}catch{throw new ApiError(400,'Invalid config path encoding');}
   const identity=await context.authorize('server.files.download',{root:'config',path:name});authorizedContext(context,identity);signal.throwIfAborted();this.#allowed(name);
   let source:FileHandle|undefined,snapshot:Awaited<ReturnType<typeof createSealedBinaryReader>>|undefined;
   try{source=await this.#source(name,signal);const before=await source.stat({bigint:true});if(before.size>BigInt(this.#max))throw new ApiError(413,'Config file size limit exceeded');
    const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let at=0;
    while(at<Number(before.size)){signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,Number(before.size)-at),at);if(!bytesRead)throw new ApiError(409,'Config changed during read');hash.update(buffer.subarray(0,bytesRead));at+=bytesRead;}
    const after=await source.stat({bigint:true});signal.throwIfAborted();if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new ApiError(409,'Config changed during read');
    try{snapshot=await createSealedBinaryReader(source,hash.digest('hex'),signal,{maxBytes:this.#max,budget:this.#budget});}catch(error){signal.throwIfAborted();if(error instanceof Error&&/source (changed|digest|truncated)/i.test(error.message))throw new ApiError(409,'Config changed during snapshot');throw error;}
    signal.throwIfAborted();await use({...snapshot,record:{id:basename(name),name:basename(name)}},signal);
   }finally{try{await snapshot?.reader.close();}finally{await source?.close();}}
  });this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Config files closed'));
  return this.#closing=(async()=>{await Promise.allSettled([...this.#pending]);try{await this.#listing.close();}finally{await this.#root.close();}})();
 }
}
