import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {basename,dirname,isAbsolute,resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {configBackupCapacity,isConfigBackup,managedConfigBackup,deleteNativeConfigBackup} from '../config/native-config-backups.ts';
import {replaceNativeConfig} from '../config/native-config-replace.ts';
import {KlipperSaveCommitError} from '../config/klipper-save-commit.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {FileListing,type FileListingOptions,type FileDirectory} from './file-list.ts';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import {createSealedBinaryReader} from '../gcode/sealed-file.ts';
import {PrintSnapshotBudget,defaultPrintSnapshotBudget} from '../gcode/snapshot-budget.ts';

export interface NativeConfigFilesOptions {
 root:string;
 /** Existing files permitted for editor saves; omitted means read-only. */
 writable?:readonly string[];
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
 readonly #writable=new Set<string>();#writer:((context:RpcContext)=>{release:()=>void;signal:AbortSignal})|undefined;#writing=false;
 readonly #changes=new Set<(event:Json)=>void>();
 #backupReads=0;
 readonly #stop=new AbortController();readonly #pending=new Set<Promise<unknown>>();#closing:Promise<void>|undefined;
 private constructor(root:FileHandle,listing:FileListing,reserved:readonly string[],max:number,capacity:number){this.#root=root;this.#listing=listing;this.#reserved=reserved;this.#max=max;this.#capacity=capacity;const page=defaultPrintSnapshotBudget.status.pageBytes;this.#budget=new PrintSnapshotBudget({maxSnapshots:capacity,maxBytes:Math.ceil(max/page)*page*capacity});}
 static async open(options:NativeConfigFilesOptions):Promise<NativeConfigFiles>{
  const max=options?.maxFileBytes??4*1024**2,capacity=options?.maxDownloads??2;
  if(!options||typeof options.root!=='string'||!isAbsolute(options.root)||!options.root.isWellFormed()||/[\0\r\n]/u.test(options.root)||Buffer.byteLength(options.root)>4096||resolve(options.root)==='/'||!Number.isSafeInteger(max)||max<1||max>16*1024**2||!Number.isSafeInteger(capacity)||capacity<1||capacity>4)throw new TypeError('Invalid native config root or limits');
  const reserved=options.reserved??[];
  if(!Array.isArray(reserved)||reserved.length>256)throw new TypeError('Invalid config reserved paths');
  for(const path of reserved)NativeConfigFiles.#name(path);
  const path=resolve(options.root),root=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const writable=options.writable??[];if(!Array.isArray(writable)||writable.length>256){await root.close();throw new TypeError('Invalid writable config paths');}
  try{for(const name of writable){NativeConfigFiles.#name(name);if(name.split('/').includes('.git')||reserved.some(p=>name===p||name.startsWith(p+'/')))throw new TypeError('Writable config path is reserved');}
   const listing=await FileListing.open({...options.listing,confined:true,roots:[{name:'config',path,writable:false,descriptor:root.fd}],reserved:reserved.map(name=>({path:resolve(path,name),canRead:false}))});const owner=new NativeConfigFiles(root,listing,[...reserved],max,capacity);for(const name of writable)owner.#writable.add(name);return owner;}
  catch(error){await root.close();throw error;}
 }
 static #name(value:unknown):asserts value is string{
  if(typeof value!=='string'||!value||!value.isWellFormed()||Buffer.byteLength(value)>4096||/[\\\0-\x1f\x7f]/u.test(value)||isAbsolute(value)||value.split('/').some(part=>!part||part==='.'||part==='..')||value.split('/').length>64)throw new ApiError(400,'Invalid config path');
 }
 get status(){return {writing:this.#writing,maxFileBytes:this.#max,closed:this.#stop.signal.aborted,pending:this.#pending.size,listings:this.#listing.pendingRequests,snapshots:this.#budget.status};}
 root(){this.#stop.signal.throwIfAborted();return {...this.#listing.roots()[0]!,permissions:this.#writable.size?'rw':'r'};}
 contains(path:string):boolean{const name=relative(this.root().path,resolve(path));return name!==''&&!isAbsolute(name)&&name!=='..'&&!name.startsWith('..'+sep);}
 #allowed(name:string){NativeConfigFiles.#name(name);if(name.split('/').includes('.git')||this.#reserved.some(path=>name===path||name.startsWith(path+'/')))throw new ApiError(403,'Reserved config path');}
 async list(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  if(Object.keys(params).some(key=>key!=='root')||params.root!=='config')throw new ApiError(400,'Expected config root');this.#stop.signal.throwIfAborted();
  return (await this.#listing.list('config',AbortSignal.any([signal,this.#stop.signal]))).map(file=>({...file,permissions:file.permissions?this.#writable.has(file.path)?'rw':'r':''})) as unknown as Json;
 }
 async directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  if(Object.keys(params).some(key=>!['path','extended'].includes(key))||typeof params.path!=='string')throw new ApiError(400,'Expected config directory');
  const value=params.path.replace(/^\/|\/$/g,''),name=value==='config'?'':value.startsWith('config/')?value.slice(7):undefined;
  if(name===undefined)throw new ApiError(400,'Invalid config root');if(name)this.#allowed(name);
  const extended=params.extended??false;if(typeof extended!=='boolean'&&(typeof extended!=='string'||!['true','false'].includes(extended.toLowerCase())))throw new ApiError(400,'Invalid extended flag');
  this.#stop.signal.throwIfAborted();const result=(await this.#listing.directory(value,AbortSignal.any([signal,this.#stop.signal]))).result;result.root_info.permissions=this.#writable.size?'rw':'r';
  result.files=result.files.map(file=>({...file,permissions:file.permissions?this.#writable.has(name?name+'/'+file.filename:file.filename as string)?'rw':'r':''}));return result as unknown as Json;
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
 bindWriter(writer:(context:RpcContext)=>{release:()=>void;signal:AbortSignal}):()=>void{if(this.#writer||typeof writer!=='function'||this.#stop.signal.aborted)throw new Error('Config writer already owned or closed');this.#writer=writer;return ()=>{if(this.#writer===writer)this.#writer=undefined;};}
 observeChanges(observer:(event:Json)=>void):()=>void{this.#changes.add(observer);return ()=>this.#changes.delete(observer);}
 async #parent(name:string,signal:AbortSignal):Promise<FileHandle>{
  let parent=await open('/proc/self/fd/'+this.#root.fd,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NONBLOCK);
  try{for(const part of dirname(name)==='.'?[]:dirname(name).split('/')){signal.throwIfAborted();const next=await open('/proc/self/fd/'+parent.fd+'/'+part,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{await parent.close();}catch(e){await next.close();throw e;}parent=next;}return parent;}catch(e){await parent.close();throw e;}
 }
 #emit(event:Json){for(const observer of this.#changes)try{observer(event);}catch{}}
 #mutate(context:RpcContext,run:(signal:AbortSignal)=>Promise<Json>):Promise<Json>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Config files closed'));if(this.#writing)return Promise.reject(new ApiError(409,'Another config mutation is pending'));
  this.#writing=true;const signal=AbortSignal.any([context.signal,this.#stop.signal]),task=Promise.resolve().then(()=>run(signal));this.#pending.add(task);return task.finally(()=>{this.#pending.delete(task);this.#writing=false;});
 }
 save(name:string,bytes:Buffer,expected:string|undefined,context:RpcContext):Promise<Json>{
  if(!Buffer.isBuffer(bytes)||bytes.length>this.#max)return Promise.reject(new ApiError(413,'Config size limit exceeded'));if(this.#writing)return Promise.reject(new ApiError(409,'Another config mutation is pending'));const copy=Buffer.from(bytes);return this.#mutate(context,signal=>this.#save(name,copy,expected,context,signal));
 }
 async #save(name:string,bytes:Buffer,expected:string|undefined,context:RpcContext,signal:AbortSignal,held?:{release:()=>void;signal:AbortSignal}):Promise<Json>{
   authorizedContext(context,await context.authorize('server.files.upload',{root:'config',path:name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')}));signal.throwIfAborted();this.#allowed(name);
   if(!this.#writable.has(name))throw new ApiError(403,'Config file is read-only');
   if(bytes.length>this.#max)throw new ApiError(413,'Config size limit exceeded');if(expected!==undefined&&!/^[a-f0-9]{64}$/.test(expected))throw new ApiError(400,'Invalid previous config digest');
   // Binary and invalid UTF-8 config cannot enter the parser; invalid textual
   // config remains saveable so failed startup can be repaired explicitly.
   try{new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new ApiError(400,'Expected UTF-8 config');}if(bytes.includes(0))throw new ApiError(400,'Config contains NUL');
   if(!this.#writer&&!held)throw new ApiError(503,'Config writer is not attached');const lease=held??this.#writer!(context),owned=AbortSignal.any([signal,lease.signal]);let parent:FileHandle|undefined;
   try{owned.throwIfAborted();parent=await this.#parent(name,owned);const result=await replaceNativeConfig(parent,basename(name),bytes,expected,this.#max,owned),stat=result.modified;
    const item={path:name,root:'config',modified:stat,size:bytes.length,permissions:'rw'},event={item,action:'create_file'};this.#emit(event);
    const rotatedBackup=result.rotatedBackup?(dirname(name)==='.'?result.rotatedBackup:dirname(name)+'/'+result.rotatedBackup):null;
    if(rotatedBackup)this.#emit({action:'delete_file',item:{path:rotatedBackup,root:'config',size:0,modified:0,permissions:''}});
    return {...event,...result,rotatedBackup,backup:dirname(name)==='.'?result.backup:dirname(name)+'/'+result.backup,print_started:false,print_queued:false};
   }catch(e){if(e instanceof KlipperSaveCommitError)throw new ApiError(500,'Configuration save durability is uncertain',{phase:e.phase,backup:e.backupPath??null});if(['ENOENT','ENOTDIR','ELOOP'].includes((e as NodeJS.ErrnoException).code??''))throw new ApiError(409,'Config source or parent unavailable');throw e;}finally{try{await parent?.close();}finally{if(!held)lease.release();}}
 }
 backups(name:string,context:RpcContext):Promise<Json>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Config files closed'));
  if(this.#backupReads>=4)return Promise.reject(new ApiError(429,'Config backup query capacity exceeded'));
  this.#backupReads++;const signal=AbortSignal.any([context.signal,this.#stop.signal]),task=Promise.resolve().then(async()=>{
   signal.throwIfAborted();authorizedContext(context,await context.authorize('printer.host.config.backups',{path:name}));signal.throwIfAborted();this.#allowed(name);
   const prefix=dirname(name)==='.'?'':dirname(name)+'/',result=await this.directory({path:'config/'+dirname(name).replace(/^\.$/,'')},signal) as unknown as FileDirectory;
   // Listing is observational. Mutation validates exact type, owner, links and
   // digest again under the writer gate; a listed pathname grants no authority.
   const backups=result.files.filter(file=>file.permissions!==''&&typeof file.filename==='string'&&isConfigBackup(basename(name),file.filename)).map(file=>({path:prefix+file.filename,size:Number(file.size),modified:Number(file.modified),permissions:'r'}));backups.sort((a,b)=>b.modified-a.modified||a.path.localeCompare(b.path));
   return {path:name,capacity:configBackupCapacity,backups};
  });this.#pending.add(task);return task.finally(()=>{this.#pending.delete(task);this.#backupReads--;});
 }
 #backup(name:string,backup:string){this.#allowed(name);this.#allowed(backup);if(!this.#writable.has(name))throw new ApiError(403,'Config file is read-only');if(dirname(name)!==dirname(backup)||!isConfigBackup(basename(name),basename(backup)))throw new ApiError(400,'Backup does not belong to the selected config');}
 restore(name:string,backup:string,expected:string,backupDigest:string,context:RpcContext):Promise<Json>{return this.#mutate(context,async signal=>{
  authorizedContext(context,await context.authorize('printer.host.config.restore',{path:name,backup}));signal.throwIfAborted();this.#backup(name,backup);if(!/^[a-f0-9]{64}$/.test(expected)||!/^[a-f0-9]{64}$/.test(backupDigest))throw new ApiError(400,'Expected current and backup digests');
  if(!this.#writer)throw new ApiError(503,'Config writer is not attached');const lease=this.#writer(context);signal=AbortSignal.any([signal,lease.signal]);
  let source:FileHandle|undefined,snapshot:Awaited<ReturnType<typeof createSealedBinaryReader>>|undefined;
  try{authorizedContext(context,await context.authorize('server.files.download',{root:'config',path:backup}));signal.throwIfAborted();source=await this.#source(backup,signal);const stat=await source.stat({bigint:true});if(stat.size>BigInt(this.#max))throw new ApiError(413,'Backup size limit exceeded');if(!managedConfigBackup(stat))throw new ApiError(409,'Backup ownership or type changed');try{snapshot=await createSealedBinaryReader(source,backupDigest,signal,{maxBytes:this.#max,budget:this.#budget});}catch(e){signal.throwIfAborted();if(e instanceof Error&&e.message==='Print snapshot quota exceeded')throw new ApiError(429,'Config snapshot capacity exceeded');if(e instanceof Error&&/source (changed|digest|truncated)/i.test(e.message))throw new ApiError(409,'Backup digest conflicts');throw e;}
   const parts:Buffer[]=[];for await(const part of snapshot.reader.chunks(signal))parts.push(Buffer.from(part));const result=await this.#save(name,Buffer.concat(parts),expected,context,signal,lease) as Record<string,Json>;return {...result,restoredFrom:backup,applied:false,restartRequired:true};
  }finally{try{await snapshot?.reader.close();}finally{try{await source?.close();}finally{lease.release();}}}
 });}
 deleteBackup(name:string,backup:string,expected:string,context:RpcContext):Promise<Json>{return this.#mutate(context,async signal=>{
  authorizedContext(context,await context.authorize('printer.host.config.delete_backup',{path:name,backup}));signal.throwIfAborted();this.#backup(name,backup);if(!this.#writer)throw new ApiError(503,'Config writer is not attached');const lease=this.#writer(context),owned=AbortSignal.any([signal,lease.signal]);let parent:FileHandle|undefined;
  try{parent=await this.#parent(name,owned);const result=await deleteNativeConfigBackup(parent,basename(name),basename(backup),expected,this.#max,owned);const event={action:'delete_file',item:{path:backup,root:'config',size:0,modified:0,permissions:''}};this.#emit(event);return {...result,backup,...event};}finally{try{await parent?.close();}finally{lease.release();}}
 });}
 registerSave(endpoints:EndpointRegistry):()=>void{
  const releases:(()=>void)[]=[];try{
   releases.push(endpoints.register({endpoint:'/printer/host/config/save',methods:['POST']},async(params,_verb,context)=>{if(Object.keys(params).some(k=>!['version','path','content','expected_sha256'].includes(k))||params.version!==1||typeof params.path!=='string'||typeof params.content!=='string'||!params.content.isWellFormed()||typeof params.expected_sha256!=='string')throw new ApiError(400,'Expected versioned config save with previous digest');return this.save(params.path,Buffer.from(params.content),params.expected_sha256,context);}));
   releases.push(endpoints.register({endpoint:'/printer/host/config/backups',methods:['GET','DELETE'],rpcVerbPrefix:true},(params,verb,context)=>{
    if(verb==='GET'){if(Object.keys(params).some(k=>k!=='path')||typeof params.path!=='string')throw new ApiError(400,'Expected config path');return this.backups(params.path,context);}
    if(Object.keys(params).some(k=>!['version','path','backup','backup_sha256'].includes(k))||params.version!==1||typeof params.path!=='string'||typeof params.backup!=='string'||typeof params.backup_sha256!=='string')throw new ApiError(400,'Expected versioned backup removal with digest');return this.deleteBackup(params.path,params.backup,params.backup_sha256,context);
   }));
   releases.push(endpoints.register({endpoint:'/printer/host/config/restore',methods:['POST']},(params,_verb,context)=>{if(Object.keys(params).some(k=>!['version','path','backup','backup_sha256','expected_sha256'].includes(k))||params.version!==1||typeof params.path!=='string'||typeof params.backup!=='string'||typeof params.backup_sha256!=='string'||typeof params.expected_sha256!=='string')throw new ApiError(400,'Expected current config and selected backup digests');return this.restore(params.path,params.backup,params.expected_sha256,params.backup_sha256,context);}));
  }catch(e){for(const release of releases.reverse())release();throw e;}let closed=false;return ()=>{if(closed)return;closed=true;for(const release of releases.reverse())release();};
 }
 async drainWrites():Promise<void>{await Promise.allSettled([...this.#pending]);}
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Config files closed'));
  return this.#closing=(async()=>{await Promise.allSettled([...this.#pending]);try{await this.#listing.close();}finally{await this.#root.close();}})();
 }
}
