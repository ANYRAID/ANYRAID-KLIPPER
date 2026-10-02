import busboy from 'busboy';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage} from 'node:http';
import {mkdtemp,open,rm,type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PublishedPrintFiles,PublishedFileChangedError} from '../storage/published-files.ts';
import {visibleFilePath,pathBasename,PublishedDirectoryCommitError} from '../storage/published-paths.ts';
import {nativeFilename,nativeDirectory,nativeDownloadFilename} from './native-file-path.ts';
import {PrintController} from '../operations/print.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {NativeFileMetadata} from './native-file-metadata.ts';
import {NativePersistentMetadata} from './native-persistent-metadata.ts';
export type NativeUploadOptions={stagingRoot?:string;maxFileBytes?:number;maxUploads?:number;maxDownloads?:number;maxDownloadBytes?:number};
import type {ThumbnailDownload} from './thumbnail-download.ts';
export type NativeFileDownload=Awaited<ReturnType<PublishedPrintFiles['acquireBinary']>>;
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {ApiError,authorizedContext,type Json,type RpcContext} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {NativeConfigFiles} from './native-config-files.ts';
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
/** Native-mode multipart admission. Publishes immutable bytes, never starts a
 * print. The file store is externally owned and must also back FilePrintDevice. */
export class NativePrintUploads {
 readonly #files:PublishedPrintFiles;readonly #gate:MaintenanceGate;readonly #root:string;readonly #max:number;readonly #capacity:number;
 readonly #abort=new AbortController();readonly #pending=new Set<Promise<unknown>>();readonly #authorizing=new Set<Promise<unknown>>();
 #metadata:NativeFileMetadata|NativePersistentMetadata;
 readonly #downloads=new Set<Promise<void>>();readonly #downloadBudget:PrintSnapshotBudget;readonly #maxDownloads:number;
 #closed=false;#published=0;
 #draining:Promise<void>|undefined;
 #print:PrintController|undefined;
 readonly #metadataOwner:NativePrintUploads|undefined;
 #deviceFiles:{owner:NativePrintUploads;signal:AbortSignal}|undefined;
 get metadataOwner(){return this.#metadataOwner;}
 constructor(files:PublishedPrintFiles,gate:MaintenanceGate,options:NativeUploadOptions={},metadataOwner?:NativePrintUploads){
  if(!(files instanceof PublishedPrintFiles)||!(gate instanceof MaintenanceGate))throw new Error('Invalid native upload owner');
  const max=options.maxFileBytes??Math.min(files.status.maxFileBytes,64*1024**2),capacity=options.maxUploads??2,root=options.stagingRoot??tmpdir();
  if(!(files instanceof PublishedPrintFiles)||files.status.closed||!(gate instanceof MaintenanceGate)||gate.status.closed||!isAbsolute(root)||!Number.isSafeInteger(max)||max<1||max>64*1024**2||max>files.status.maxFileBytes||!Number.isSafeInteger(capacity)||capacity<1||capacity>4)throw new Error('Invalid native upload owner or limits');
  const downloads=options.maxDownloads??2,downloadBytes=options.maxDownloadBytes??64*1024**2;
  if(!Number.isSafeInteger(downloads)||downloads<1||downloads>4||!Number.isSafeInteger(downloadBytes)||downloadBytes<1||downloadBytes>1024**3)throw new Error('Invalid native download limits');
  this.#maxDownloads=downloads;this.#downloadBudget=new PrintSnapshotBudget({maxBytes:downloadBytes,maxSnapshots:downloads});
  if(metadataOwner&&(!(metadataOwner instanceof NativePrintUploads)||metadataOwner.#files!==files||metadataOwner.#closed||metadataOwner.#metadataOwner))throw new Error('Invalid process metadata owner');
  this.#metadataOwner=metadataOwner;this.#metadata=metadataOwner?metadataOwner.#metadata:new NativeFileMetadata(files);this.#files=files;this.#gate=gate;this.#root=root;this.#max=max;this.#capacity=capacity;
 }
 static async open(files:PublishedPrintFiles,gate:MaintenanceGate,options:NativeUploadOptions&{metadataRoot:string}):Promise<NativePrintUploads>{
  const owner=new NativePrintUploads(files,gate,options);
  try{const metadata=await NativePersistentMetadata.open(options.metadataRoot,files),previous=owner.#metadata;owner.#metadata=metadata;await previous.close();return owner;}catch(error){try{await owner.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native upload startup cleanup failed');}throw error;}
 }
 get status(){return {closed:this.#closed,metadata:this.#metadata.status,downloads:this.#downloads.size,downloadSnapshots:this.#downloadBudget.status,pending:this.#pending.size,authorizing:this.#authorizing.size,published:this.#published,maxUploads:this.#capacity,maxFileBytes:this.#max};}
 async rootInfo(signal:AbortSignal):Promise<Json>{return {name:'gcodes',path:await this.#files.directoryPath(signal),permissions:'rw'};}
 filename(fileId:string):string{if(!validId(fileId))throw new ApiError(400,'Invalid native file ID');return this.#files.filename(fileId);}
 usesGate(gate:MaintenanceGate):boolean{return gate===this.#gate;}
 acceptsController(controller:PrintController):boolean{return controller instanceof PrintController&&controller.usesMaintenanceGate(this.#gate)&&(!this.#print||this.#print===controller);}
 bindPrintController(controller:PrintController):void{if(!this.acceptsController(controller))throw new Error('Invalid native file print owner');this.#print=controller;}
 get canRemove():boolean{return !this.#closed&&(!!this.#print||!!this.#deviceFiles?.owner.canRemove);}
 /** Process reads/metadata outlive this replaceable mutation delegate. */
 bindDeviceFiles(owner:NativePrintUploads,signal:AbortSignal):void{
  if(this.#closed||this.#deviceFiles||!(owner instanceof NativePrintUploads)||owner.metadataOwner!==this||owner.#closed||!owner.#print||!(signal instanceof AbortSignal)||signal.aborted)throw new Error('Invalid device file binding');
  const binding={owner,signal};this.#deviceFiles=binding;
  signal.addEventListener('abort',()=>{if(this.#deviceFiles===binding)this.#deviceFiles=undefined;},{once:true});
 }
 observeChanges(observer:(event:Json)=>void):()=>void{
  if(this.#closed)throw new ApiError(503,'Native files closed');
  const release=this.#files.observeChanges(({action,file,modified})=>{
   if(this.#closed)return;const path=visibleFilePath(file);if(action==='delete_file')void Promise.resolve(this.#metadata.invalidate(path)).catch(()=>{});
   observer({action,item:{path,root:'gcodes',modified,size:action==='delete_file'?0:file.size,permissions:action==='delete_file'?'':this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256}});
  });
  try{const directories=this.#files.observeDirectories(({action,path,modified})=>{if(!this.#closed)observer({action,item:{path,root:'gcodes',modified,size:0,permissions:action==='delete_dir'?'':'rw'}});});return ()=>{release();directories();};}catch(error){release();throw error;}
 }
 remove(params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native files closed'));
  if(this.#deviceFiles){const binding=this.#deviceFiles;if(context.nativeGenerationSignal&&context.nativeGenerationSignal!==binding.signal)return Promise.reject(new ApiError(503,'File mutation belongs to a retired device'));return binding.owner.remove(params,{...context,signal:AbortSignal.any([context.signal,binding.signal])});}
  if(this.#closed||!this.#print)return Promise.reject(new ApiError(503,'Native file removal requires its print owner'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Native file mutation capacity exceeded'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal]),task=Promise.resolve().then(async()=>{
   await this.#authorize(context,{...params},signal,'server.files.delete_file');
   if(Object.keys(params).some(key=>key!=='path')||typeof params.path!=='string')throw new ApiError(400,'Expected native gcodes file path');
   const path=nativeDirectory(params.path);if(!path)throw new ApiError(400,'Expected a file below gcodes');let release:(()=>void)|undefined;
   try{
    const id=await this.#files.resolvePath(path,signal);
    const {file}=await this.#files.describe(id,signal);
    await this.#authorize(context,{path:params.path,file_id:id,filename:file.name,size:file.size,sha256:file.sha256},signal,'server.files.delete_file');
    try{release=this.#print!.beginFileMutation(id);}catch{throw new ApiError(409,'Print or maintenance owns this file');}
    if(await this.#files.resolvePath(path,signal)!==id)throw new ApiError(409,'Published path changed during authorization');
    await this.#files.remove(id,signal,file);await this.#metadata.invalidate(path);
    return {item:{path,root:'gcodes',size:0,modified:0,permissions:''},action:'delete_file'};
   }catch(error){if(error instanceof PublishedFileChangedError)throw new ApiError(409,error.message);if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}finally{release?.();}
  });this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 async #authorize(context:RpcContext,params:Record<string,Json>,signal:AbortSignal,method='server.files.upload'):Promise<void>{
  signal.throwIfAborted();if(this.#authorizing.size>=this.#capacity*2)throw new ApiError(503,'Upload authorization capacity exceeded');
  const pending=Promise.resolve().then(()=>{signal.throwIfAborted();return context.authorize(method,Object.freeze(params));});this.#authorizing.add(pending);
  void pending.then(()=>this.#authorizing.delete(pending),()=>this.#authorizing.delete(pending));
  await new Promise<void>((resolve,reject)=>{const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();void pending.then(value=>{try{authorizedContext(context,value);resolve();}catch(error){reject(error);}},reject).finally(()=>signal.removeEventListener('abort',aborted));});signal.throwIfAborted();
 }
 /** Capture device ownership at HTTP admission, before the network work queue. */
 captureUpload(configFiles?:NativeConfigFiles){const binding=this.#deviceFiles;return (request:IncomingMessage,context:RpcContext)=>this.#receiveOwned(request,context,binding,configFiles);}
 receive(request:IncomingMessage,context:RpcContext):Promise<Json>{return this.#receiveOwned(request,context,this.#deviceFiles);}
 #receiveOwned(request:IncomingMessage,context:RpcContext,binding:{owner:NativePrintUploads;signal:AbortSignal}|undefined,configFiles?:NativeConfigFiles):Promise<Json>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native uploads are closed'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Too many uploads'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal,...binding?[binding.signal]:[]]);
  const task=Promise.resolve().then(()=>this.#receive(request,context,signal,binding?binding.owner.#gate:undefined,configFiles));this.#pending.add(task);
  void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 async #receive(request:IncomingMessage,context:RpcContext,signal:AbortSignal,deviceGate?:MaintenanceGate,configFiles?:NativeConfigFiles):Promise<Json>{
  signal.throwIfAborted();let release:()=>void;
  try{release=this.#gate.activity();}catch{throw new ApiError(409,'Maintenance blocks file uploads');}
  let releaseDevice:(()=>void)|undefined;try{if(deviceGate&&deviceGate!==this.#gate)releaseDevice=deviceGate.activity();}catch{release();throw new ApiError(409,'Maintenance blocks file uploads');}
  let directory:string|undefined,file:FileHandle|undefined;
  try{
   const query=new URL(request.url??'','http://localhost').searchParams;
   if([...query.keys()].some(key=>key!=='token')||query.getAll('token').length>1||query.has('token')&&!/^[A-Z2-7]{32}$/.test(query.get('token')!)||!/^multipart\/form-data(?:;|$)/i.test(request.headers['content-type']??''))throw new ApiError(400,'Expected multipart upload with at most one access token');
   const length=request.headers['content-length'];if(length!==undefined&&(!/^\d+$/.test(length)||Number(length)>this.#max+65536))throw new ApiError(413,'Upload body limit exceeded');
   await this.#authorize(context,{},signal);signal.throwIfAborted();
   directory=await mkdtemp(join(this.#root,'anyraid-upload-'));file=await open(join(directory,'source'),'wx+',0o600);
   let parser:ReturnType<typeof busboy>;try{parser=busboy({headers:request.headers,preservePath:true,defParamCharset:'utf8',highWaterMark:65536,fileHwm:65536,limits:{fileSize:this.#max+1,files:1,fields:5,fieldNameSize:128,fieldSize:1024,parts:7}});}catch{throw new ApiError(400,'Invalid multipart content type');}
   const fields:Record<string,string>=Object.create(null),hash=createHash('sha256');let filename:string|undefined,bytes=0,bodyBytes=0,fileTask:Promise<void>|undefined;
   const invalid=(message:string)=>parser.destroy(new ApiError(400,message));
   parser.on('field',(name,value,info)=>{if(info.nameTruncated||info.valueTruncated||Object.hasOwn(fields,name)||!['root','path','print','checksum','file_id'].includes(name))invalid('Invalid or duplicate upload field');else fields[name]=value;});
   for(const event of ['filesLimit','fieldsLimit','partsLimit'] as const)parser.on(event,()=>invalid('Multipart part capacity exceeded'));
   parser.on('file',(name,source,info)=>{
    source.on('error',()=>{});
    if(fileTask||name!=='file'||!info.filename||info.filename.length>256||!info.filename.isWellFormed()||/[\\/\u0000-\u001f\u007f]/u.test(info.filename)||!configFiles&&!/\.(gcode|gco|g)$/i.test(info.filename)||!['7bit','8bit','binary'].includes(info.encoding)){source.resume();invalid('Expected one named G-code file');return;}
    filename=info.filename;
    fileTask=(async()=>{for await(const chunk of source){signal.throwIfAborted();const buffer=chunk as Buffer;bytes+=buffer.length;if(bytes>this.#max)throw new ApiError(413,'Upload file limit exceeded');hash.update(buffer);let offset=0;while(offset<buffer.length){signal.throwIfAborted();const result=await file!.write(buffer,offset,buffer.length-offset);if(!result.bytesWritten)throw new Error('Upload staging write stalled');offset+=result.bytesWritten;}}if(source.truncated)throw new ApiError(413,'Upload file limit exceeded');})();
    void fileTask.catch(error=>parser.destroy(error));
   });
   const limiter=new Transform({highWaterMark:65536,transform:(chunk:Buffer,_encoding,callback)=>{bodyBytes+=chunk.length;callback(bodyBytes>this.#max+65536?new ApiError(413,'Upload body limit exceeded'):null,chunk);}});
   const failed=(error:Error)=>limiter.destroy(error);request.on('error',failed);
   try{const parsing=pipeline(limiter,parser,{signal});request.pipe(limiter);await parsing;await fileTask;}
   catch(error){await fileTask?.catch(()=>{});if(signal.aborted)throw signal.reason;if(error instanceof ApiError)throw error;throw new ApiError(400,'Invalid multipart upload');}
   finally{request.unpipe(limiter);request.removeListener('error',failed);}
   signal.throwIfAborted();if(!filename||!fileTask)throw new ApiError(400,'Upload file is missing');
   if(fields.root==='config'&&configFiles){
    if(fields.file_id!==undefined||fields.print!==undefined&&!['false','0',''].includes(fields.print)||fields.checksum!==undefined&&(!/^[a-fA-F0-9]{64}$/.test(fields.checksum)||fields.checksum.toLowerCase()!==hash.digest('hex')))throw new ApiError(422,'Invalid config upload fields or checksum');
    if(bytes>configFiles.status.maxFileBytes)throw new ApiError(413,'Config size limit exceeded');const content=Buffer.alloc(bytes);let at=0;while(at<bytes){signal.throwIfAborted();const r=await file.read(content,at,Math.min(65536,bytes-at),at);if(!r.bytesRead)throw new ApiError(400,'Config staging truncated');at+=r.bytesRead;}
    const name=fields.path?fields.path+'/'+filename:filename;const condition=request.headers['if-match'];if(condition!==undefined&&typeof condition!=='string')throw new ApiError(400,'Expected one config version digest');
    releaseDevice?.();releaseDevice=undefined;release();return await configFiles.save(name,content,condition?.replace(/^"|"$/g,''),context);
   }
   if(!/\.(gcode|gco|g)$/i.test(filename))throw new ApiError(400,'Expected one named G-code file');
   if(fields.root!==undefined&&fields.root!=='gcodes'||fields.print!==undefined&&!['false','0',''].includes(fields.print))throw new ApiError(400,'Native upload uses gcodes storage; start printing with a separate durable request');
   const id=fields.file_id??randomUUID(),sha256=hash.digest('hex');if(!validId(id))throw new ApiError(400,'Invalid upload file ID');
   // Explicit legacy IDs without a path retain their already issued addresses.
   // Standard multipart clients publish the actual filename in the visible tree.
   const visibleDirectory=fields.path?nativeFilename(fields.path):'',visible=fields.file_id!==undefined&&fields.path===undefined?undefined:nativeFilename((visibleDirectory?visibleDirectory+'/':'')+filename);
   if(fields.checksum!==undefined&&(!/^[a-fA-F0-9]{64}$/.test(fields.checksum)||fields.checksum.toLowerCase()!==sha256))throw new ApiError(422,'Upload checksum mismatch');
   await this.#authorize(context,{root:'gcodes',filename,...visible?{path:visible}:{},file_id:id,size:bytes,sha256},signal);signal.throwIfAborted();
   let record;try{record=await this.#files.publish(id,filename,file,signal,visible);}catch(error){if((error as NodeJS.ErrnoException)?.code==='EEXIST')throw new ApiError(409,'File ID or path exists; query its receipt');if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Upload directory not found');throw error;}
   this.#published++;const published=await this.#files.describe(id,signal);
   return {item:{path:visibleFilePath(record),root:'gcodes',modified:published.modified,size:record.size,permissions:this.canRemove?'rw':'r'},action:'create_file',file:record as unknown as Json,print_started:false,print_queued:false};
  }finally{try{await file?.close();}finally{try{if(directory)await rm(directory,{recursive:true,force:true});}finally{releaseDevice?.();release();}}}
 }
 async info(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native uploads are closed');
  if(Object.keys(params).some(key=>key!=='file_id')||!validId(params.file_id))throw new ApiError(400,'Expected file_id');
  try{const record=await this.#files.inspect(params.file_id);signal.throwIfAborted();return record as unknown as Json;}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}
 }
 matchesDownload(path:string):boolean{try{nativeDownloadFilename(path);return true;}catch{return false;}}
 matchesThumbnail(path:string):boolean{if(!path.startsWith('/server/files/gcodes/'))return false;try{return /(?:^|\/)\.thumbs\//u.test(decodeURIComponent(path.slice('/server/files/gcodes/'.length)));}catch{return false;}}
 download(path:string,context:RpcContext,consume:(file:NativeFileDownload,signal:AbortSignal)=>Promise<void>):Promise<void>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native downloads are closed'));
  if(this.#downloads.size>=this.#maxDownloads)return Promise.reject(new ApiError(429,'Too many native downloads'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal]);
  const task=Promise.resolve().then(async()=>{
   await this.#authorize(context,{path},signal,'server.files.download');signal.throwIfAborted();
   const filename=nativeDownloadFilename(path);
   let file:NativeFileDownload|undefined;
   try{
    const id=await this.#files.resolvePath(filename,signal);
    const record=await this.#files.inspect(id);signal.throwIfAborted();
    await this.#authorize(context,{path,file_id:id,filename:record.name,sha256:record.sha256,size:record.size},signal,'server.files.download');signal.throwIfAborted();
    const quota=this.#downloadBudget.status,pageBytes=Math.ceil(record.size/quota.pageBytes)*quota.pageBytes;
    if(pageBytes>quota.maxBytes)throw new ApiError(413,'File exceeds native download snapshot limit');
    if(pageBytes>quota.maxBytes-quota.reservedBytes)throw new ApiError(429,'Native download snapshot capacity exceeded');
    if(await this.#files.resolvePath(filename,signal)!==id)throw new ApiError(409,'Published path changed during authorization');
    file=await this.#files.acquireBinary(id,signal,this.#downloadBudget);signal.throwIfAborted();
    if(file.record.sha256!==record.sha256||file.record.size!==record.size||file.record.name!==record.name)throw new ApiError(409,'Published download changed during authorization');
    await consume(file,signal);
   }catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');if(error instanceof Error&&error.message==='Print snapshot quota exceeded')throw new ApiError(429,'Native download snapshot capacity exceeded');throw error;}
   finally{await file?.reader.close();}
  });
  this.#downloads.add(task);void task.then(()=>this.#downloads.delete(task),()=>this.#downloads.delete(task));return task;
 }
 hasThumbnail(path:string):boolean{return this.#metadata.hasThumbnail(path);}
 resolveThumbnail(path:string,context:RpcContext):Promise<ThumbnailDownload>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native thumbnails closed'));const signal=AbortSignal.any([context.signal,this.#abort.signal]);
  const task=this.#metadata.resolveThumbnail(path,{...context,signal,authorize:async(method,params)=>this.#authorize(context,{...params,...(typeof params.filename==='string'?{file_id:await this.#files.resolvePath(nativeFilename(params.filename),signal)}:{})},signal,method)}).catch(error=>{if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Thumbnail source not found');throw error;});this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 thumbnails(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json[]>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native thumbnails closed'));
  if(typeof params.filename!=='string'||Object.keys(params).some(key=>key!=='filename'))return Promise.reject(new ApiError(400,'Expected filename'));
  return this.#metadata.thumbnails(params.filename,signal);
 }
 metadata(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Record<string,Json>>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native metadata closed'));
  if(typeof params.filename!=='string'||Object.keys(params).some(key=>key!=='filename'))return Promise.reject(new ApiError(400,'Expected filename'));
  return this.#metadata.metadata(params.filename,signal);
 }
 directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{const task=this.#directory(params,signal);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));}
 mutateDirectory(params:Readonly<Record<string,Json>>,verb:'POST'|'DELETE',context:RpcContext):Promise<Json>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native files closed'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Native file mutation capacity exceeded'));
  const binding=this.#deviceFiles,signal=AbortSignal.any([context.signal,this.#abort.signal,...binding?[binding.signal]:[]]);
  const task=Promise.resolve().then(async()=>{
   signal.throwIfAborted();if(Object.keys(params).some(key=>!['path',...(verb==='DELETE'?['force']:[])].includes(key)))throw new ApiError(400,'Invalid directory mutation arguments');
   const path=nativeDirectory(params.path);if(!path)throw new ApiError(400,'Cannot mutate the gcodes root');
   if(params.force!==undefined&&params.force!==false&&params.force!=='false')throw new ApiError(400,'Recursive deletion requires a separate controlled operation');
   let release:(()=>void)|undefined,releaseDevice:(()=>void)|undefined;
   try{
    try{release=this.#gate.activity();if(binding&&binding.owner.#gate!==this.#gate)releaseDevice=binding.owner.#gate.activity();}catch{throw new ApiError(409,'Maintenance blocks directory mutation');}
    await this.#authorize(context,{path:'gcodes/'+path},signal,verb==='POST'?'server.files.post_directory':'server.files.delete_directory');signal.throwIfAborted();
    const changed=await this.#files.mutateDirectory(path,verb==='DELETE',signal);
    return {action:changed.action,item:{path,root:'gcodes',modified:changed.modified,size:0,permissions:verb==='DELETE'?'':'rw'}};
   }catch(error){if(error instanceof PublishedDirectoryCommitError)throw new ApiError(500,'Directory transaction requires recovery',{phase:error.phase});const code=(error as NodeJS.ErrnoException)?.code;if(code==='ENOENT')throw new ApiError(404,'Directory or parent not found');if(code==='EEXIST'||code==='ENOTEMPTY')throw new ApiError(409,code==='EEXIST'?'Directory or file already exists':'Directory is not empty');throw error;}
   finally{releaseDevice?.();release?.();}
  });this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 async #directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native files closed');
  if(Object.keys(params).some(key=>!['path','extended'].includes(key)))throw new ApiError(400,'Invalid directory arguments');
  let path:string;try{path=nativeDirectory(params.path??'gcodes');}catch(error){if(typeof params.path==='string'&&error instanceof ApiError&&error.status===400)throw new ApiError(404,'Native directory not found');throw error;}
  const extended=params.extended??false;if(typeof extended!=='boolean'&&(typeof extended!=='string'||!['true','false'].includes(extended.toLowerCase())))throw new ApiError(400,'Invalid extended flag');
  const signalOwned=AbortSignal.any([signal,this.#abort.signal]);let entries;try{entries=await this.#files.directoryCatalog(path,signalOwned);}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Native directory not found');throw error;}const usage=await this.#files.diskUsage(signalOwned);signalOwned.throwIfAborted();
  const files=entries.files.map(({file,modified})=>{const filename=visibleFilePath(file),extra=extended===true||typeof extended==='string'&&extended.toLowerCase()==='true'?this.#metadata.peek(filename,file,modified):undefined;return {...extra,filename:pathBasename(filename),modified,size:file.size,permissions:this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256};});
  const result={dirs:entries.directories.map(entry=>({dirname:pathBasename(entry.path),modified:entry.modified,size:0,permissions:'rw'})),files,disk_usage:usage,root_info:{name:'gcodes',permissions:'rw'}};
  if(Buffer.byteLength(JSON.stringify(result))>900000)throw new ApiError(413,'Native directory exceeds response limit');return result;
 }
 async list(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native uploads are closed');
  if(Object.keys(params).some(key=>key!=='root')||params.root!==undefined&&typeof params.root!=='string')throw new ApiError(400,'Expected optional root');
  if(params.root!==undefined&&params.root!=='gcodes')throw new ApiError(404,'Native file root not found');
  const combined=AbortSignal.any([signal,this.#abort.signal]);
  const task=this.#files.catalog(combined);this.#pending.add(task);
  let entries;try{entries=await task;}finally{this.#pending.delete(task);}combined.throwIfAborted();
  // Paths identify immutable receipts, not shared blobs or mutable display names.
  const result=entries.map(({file,modified})=>({path:visibleFilePath(file),modified,size:file.size,permissions:this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256}));
  if(Buffer.byteLength(JSON.stringify(result))>900000)throw new ApiError(413,'Native file catalog exceeds response limit');return result;
 }
 /** Cancel requests and staging promptly. External policies may ignore their
  * signal; the dependency owner must drain them before releasing resources. */
 close():Promise<void>{this.#closed=true;this.#abort.abort(new ApiError(503,'Native uploads closed'));return Promise.all([Promise.allSettled([...this.#pending,...this.#downloads]),this.#metadataOwner?undefined:this.#metadata.close()]).then(()=>{});}
 drain():Promise<void>{
  return this.#draining??=(async()=>{
   const [closed]=await Promise.allSettled([this.close()]);
   await Promise.allSettled([...this.#authorizing]);
   if(closed.status==='rejected')throw closed.reason;
  })();
 }
}
export function registerNativeFileInfo(registry:EndpointRegistry,uploads:NativePrintUploads,options:{metadata?:boolean;reads?:NativePrintUploads;readRoutes?:boolean;deleteRoute?:boolean;configFiles?:NativeConfigFiles}={}):()=>void{
 const reads=options.reads??uploads;
 const release:(()=>void)[]=[];
 try{
  if(options.readRoutes!==false){
   release.push(registry.register({endpoint:'/server/files/roots',methods:['GET']},async(_params,_verb,context)=>[await reads.rootInfo(context.signal),...options.configFiles?[options.configFiles.root()]:[]]));
   release.push(registry.register({endpoint:'/printer/files/info',methods:['GET']},(params,_verb,context)=>reads.info(params,context.signal)));
   release.push(registry.register({endpoint:'/server/files/list',methods:['GET']},(params,_verb,context)=>params.root==='config'&&options.configFiles?options.configFiles.list(params,context.signal):reads.list(params,context.signal)));
   release.push(registry.register({endpoint:'/server/files/directory',methods:['GET','POST','DELETE'],rpcVerbPrefix:true},(params,verb,context)=>{
    if(verb!=='GET')return reads.mutateDirectory(params,verb as 'POST'|'DELETE',context);
    return typeof params.path==='string'&&/^\/?config(?:\/|$)/.test(params.path)&&options.configFiles?options.configFiles.directory(params,context.signal):reads.directory(params,context.signal);
   }));
   if(options.metadata!==false){release.push(registry.register({endpoint:'/server/files/metadata',methods:['GET']},(params,_verb,context)=>reads.metadata(params,context.signal)));release.push(registry.register({endpoint:'/server/files/thumbnails',methods:['GET']},(params,_verb,context)=>reads.thumbnails(params,context.signal)));}
  }
  if(options.deleteRoute!==false)release.push(registry.register({endpoint:'/server/files/delete_file',methods:['DELETE']},(params,_verb,context)=>uploads.remove(params,context)));
  return ()=>{for(const remove of release.reverse())remove();};
 }catch(error){for(const remove of release.reverse())remove();throw error;}
}
