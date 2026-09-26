import busboy from 'busboy';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {IncomingMessage} from 'node:http';
import {mkdtemp,open,rm,type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {PublishedPrintFiles,PublishedFileChangedError} from '../storage/published-files.ts';
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
const validId=(id:unknown):id is string=>typeof id==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(id);
/** Native-mode multipart admission. Publishes immutable bytes, never starts a
 * print. The file store is externally owned and must also back FilePrintDevice. */
export class NativePrintUploads {
 readonly #files:PublishedPrintFiles;readonly #gate:MaintenanceGate;readonly #root:string;readonly #max:number;readonly #capacity:number;
 readonly #abort=new AbortController();readonly #pending=new Set<Promise<unknown>>();readonly #authorizing=new Set<Promise<unknown>>();
 #metadata:NativeFileMetadata|NativePersistentMetadata;
 readonly #downloads=new Set<Promise<void>>();readonly #downloadBudget:PrintSnapshotBudget;readonly #maxDownloads:number;
 #closed=false;#published=0;
 #print:PrintController|undefined;
 constructor(files:PublishedPrintFiles,gate:MaintenanceGate,options:NativeUploadOptions={}){
  if(!(files instanceof PublishedPrintFiles)||!(gate instanceof MaintenanceGate))throw new Error('Invalid native upload owner');
  const max=options.maxFileBytes??Math.min(files.status.maxFileBytes,64*1024**2),capacity=options.maxUploads??2,root=options.stagingRoot??tmpdir();
  if(!(files instanceof PublishedPrintFiles)||files.status.closed||!(gate instanceof MaintenanceGate)||gate.status.closed||!isAbsolute(root)||!Number.isSafeInteger(max)||max<1||max>64*1024**2||max>files.status.maxFileBytes||!Number.isSafeInteger(capacity)||capacity<1||capacity>4)throw new Error('Invalid native upload owner or limits');
  const downloads=options.maxDownloads??2,downloadBytes=options.maxDownloadBytes??64*1024**2;
  if(!Number.isSafeInteger(downloads)||downloads<1||downloads>4||!Number.isSafeInteger(downloadBytes)||downloadBytes<1||downloadBytes>1024**3)throw new Error('Invalid native download limits');
  this.#maxDownloads=downloads;this.#downloadBudget=new PrintSnapshotBudget({maxBytes:downloadBytes,maxSnapshots:downloads});
  this.#metadata=new NativeFileMetadata(files);this.#files=files;this.#gate=gate;this.#root=root;this.#max=max;this.#capacity=capacity;
 }
 static async open(files:PublishedPrintFiles,gate:MaintenanceGate,options:NativeUploadOptions&{metadataRoot:string}):Promise<NativePrintUploads>{
  const owner=new NativePrintUploads(files,gate,options);
  try{const metadata=await NativePersistentMetadata.open(options.metadataRoot,files),previous=owner.#metadata;owner.#metadata=metadata;await previous.close();return owner;}catch(error){try{await owner.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Native upload startup cleanup failed');}throw error;}
 }
 get status(){return {closed:this.#closed,metadata:this.#metadata.status,downloads:this.#downloads.size,downloadSnapshots:this.#downloadBudget.status,pending:this.#pending.size,authorizing:this.#authorizing.size,published:this.#published,maxUploads:this.#capacity,maxFileBytes:this.#max};}
 filename(fileId:string):string{if(!validId(fileId))throw new ApiError(400,'Invalid native file ID');return fileId+'.gcode';}
 usesGate(gate:MaintenanceGate):boolean{return gate===this.#gate;}
 bindPrintController(controller:PrintController):void{if(!(controller instanceof PrintController)||!controller.usesMaintenanceGate(this.#gate)||this.#print&&this.#print!==controller)throw new Error('Invalid native file print owner');this.#print=controller;}
 get canRemove():boolean{return !!this.#print&&!this.#closed;}
 observeChanges(observer:(event:Json)=>void):()=>void{
  if(this.#closed)throw new ApiError(503,'Native files closed');
  return this.#files.observeChanges(({action,file,modified})=>{
   if(this.#closed)return;if(action==='delete_file')void Promise.resolve(this.#metadata.invalidate(file.id+'.gcode')).catch(()=>{});
   observer({action,item:{path:file.id+'.gcode',root:'gcodes',modified,size:action==='delete_file'?0:file.size,permissions:action==='delete_file'?'':this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256}});
  });
 }
 remove(params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(this.#closed||!this.#print)return Promise.reject(new ApiError(503,'Native file removal requires its print owner'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Native file mutation capacity exceeded'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal]),task=Promise.resolve().then(async()=>{
   await this.#authorize(context,{...params},signal,'server.files.delete_file');
   if(Object.keys(params).some(key=>key!=='path')||typeof params.path!=='string'||!/^gcodes\/[A-Za-z0-9_-]{1,128}\.gcode$/.test(params.path))throw new ApiError(400,'Expected native gcodes file path');
   const id=params.path.slice(7,-6);let release:(()=>void)|undefined;
   try{
    const {file}=await this.#files.describe(id,signal);
    await this.#authorize(context,{path:params.path,file_id:id,filename:file.name,size:file.size,sha256:file.sha256},signal,'server.files.delete_file');
    try{release=this.#print!.beginFileMutation(id);}catch{throw new ApiError(409,'Print or maintenance owns this file');}
    await this.#files.remove(id,signal,file);await this.#metadata.invalidate(id+'.gcode');
    return {item:{path:id+'.gcode',root:'gcodes',size:0,modified:0,permissions:''},action:'delete_file'};
   }catch(error){if(error instanceof PublishedFileChangedError)throw new ApiError(409,error.message);if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}finally{release?.();}
  });this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 async #authorize(context:RpcContext,params:Record<string,Json>,signal:AbortSignal,method='server.files.upload'):Promise<void>{
  signal.throwIfAborted();if(this.#authorizing.size>=this.#capacity*2)throw new ApiError(503,'Upload authorization capacity exceeded');
  const pending=Promise.resolve().then(()=>{signal.throwIfAborted();return context.authorize(method,Object.freeze(params));});this.#authorizing.add(pending);
  void pending.then(()=>this.#authorizing.delete(pending),()=>this.#authorizing.delete(pending));
  await new Promise<void>((resolve,reject)=>{const aborted=()=>reject(signal.reason);signal.addEventListener('abort',aborted,{once:true});if(signal.aborted)aborted();void pending.then(value=>{try{authorizedContext(context,value);resolve();}catch(error){reject(error);}},reject).finally(()=>signal.removeEventListener('abort',aborted));});signal.throwIfAborted();
 }
 receive(request:IncomingMessage,context:RpcContext):Promise<Json>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native uploads are closed'));
  if(this.#pending.size>=this.#capacity)return Promise.reject(new ApiError(429,'Too many uploads'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal]);
  const task=Promise.resolve().then(()=>this.#receive(request,context,signal));this.#pending.add(task);
  void task.then(()=>this.#pending.delete(task),()=>this.#pending.delete(task));return task;
 }
 async #receive(request:IncomingMessage,context:RpcContext,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();let release:()=>void;
  try{release=this.#gate.activity();}catch{throw new ApiError(409,'Maintenance blocks file uploads');}
  let directory:string|undefined,file:FileHandle|undefined;
  try{
   if(request.url?.includes('?')||!/^multipart\/form-data(?:;|$)/i.test(request.headers['content-type']??''))throw new ApiError(400,'Expected multipart upload without query parameters');
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
    if(fileTask||name!=='file'||!info.filename||info.filename.length>256||!info.filename.isWellFormed()||/[\\/\u0000-\u001f\u007f]/u.test(info.filename)||!/\.(gcode|gco|g)$/i.test(info.filename)||!['7bit','8bit','binary'].includes(info.encoding)){source.resume();invalid('Expected one named G-code file');return;}
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
   if(fields.root!==undefined&&fields.root!=='gcodes'||fields.path!==undefined&&fields.path!==''||fields.print!==undefined&&!['false','0',''].includes(fields.print))throw new ApiError(400,'Native upload uses flat gcodes storage; start printing with a separate durable request');
   const id=fields.file_id??randomUUID(),sha256=hash.digest('hex');if(!validId(id))throw new ApiError(400,'Invalid upload file ID');
   if(fields.checksum!==undefined&&(!/^[a-fA-F0-9]{64}$/.test(fields.checksum)||fields.checksum.toLowerCase()!==sha256))throw new ApiError(422,'Upload checksum mismatch');
   await this.#authorize(context,{root:'gcodes',filename,file_id:id,size:bytes,sha256},signal);signal.throwIfAborted();
   let record;try{record=await this.#files.publish(id,filename,file,signal);}catch(error){if((error as NodeJS.ErrnoException)?.code==='EEXIST')throw new ApiError(409,'File ID exists; query its receipt');throw error;}
   this.#published++;return {file:record as unknown as Json,print_started:false,print_queued:false};
  }finally{try{await file?.close();}finally{try{if(directory)await rm(directory,{recursive:true,force:true});}finally{release();}}}
 }
 async info(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native uploads are closed');
  if(Object.keys(params).some(key=>key!=='file_id')||!validId(params.file_id))throw new ApiError(400,'Expected file_id');
  try{const record=await this.#files.inspect(params.file_id);signal.throwIfAborted();return record as unknown as Json;}catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}
 }
 matchesDownload(path:string):boolean{return /^\/server\/files\/gcodes\/[A-Za-z0-9_-]{1,128}\.gcode$/.test(path);}
 download(path:string,context:RpcContext,consume:(file:NativeFileDownload,signal:AbortSignal)=>Promise<void>):Promise<void>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Native downloads are closed'));
  if(this.#downloads.size>=this.#maxDownloads)return Promise.reject(new ApiError(429,'Too many native downloads'));
  const signal=AbortSignal.any([context.signal,this.#abort.signal]);
  const task=Promise.resolve().then(async()=>{
   await this.#authorize(context,{path},signal,'server.files.download');signal.throwIfAborted();
   if(!this.matchesDownload(path))throw new ApiError(404,'Native download not found');const id=path.slice('/server/files/gcodes/'.length,-6);
   let file:NativeFileDownload|undefined;
   try{
    const record=await this.#files.inspect(id);signal.throwIfAborted();
    await this.#authorize(context,{path,file_id:id,filename:record.name,sha256:record.sha256,size:record.size},signal,'server.files.download');signal.throwIfAborted();
    const quota=this.#downloadBudget.status,pageBytes=Math.ceil(record.size/quota.pageBytes)*quota.pageBytes;
    if(pageBytes>quota.maxBytes)throw new ApiError(413,'File exceeds native download snapshot limit');
    if(pageBytes>quota.maxBytes-quota.reservedBytes)throw new ApiError(429,'Native download snapshot capacity exceeded');
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
  const task=this.#metadata.resolveThumbnail(path,{...context,signal,authorize:(method,params)=>this.#authorize(context,{...params,...(typeof params.filename==='string'&&/^[A-Za-z0-9_-]{1,128}\.gcode$/.test(params.filename)?{file_id:params.filename.slice(0,-6)}:{})},signal,method)});this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 thumbnails(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json[]>{
  if(typeof params.filename!=='string'||Object.keys(params).some(key=>key!=='filename'))return Promise.reject(new ApiError(400,'Expected filename'));
  return this.#metadata.thumbnails(params.filename,signal);
 }
 metadata(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Record<string,Json>>{
  if(typeof params.filename!=='string'||Object.keys(params).some(key=>key!=='filename'))return Promise.reject(new ApiError(400,'Expected filename'));
  return this.#metadata.metadata(params.filename,signal);
 }
 directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{const task=this.#directory(params,signal);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));}
 async #directory(params:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<Json>{
  signal.throwIfAborted();if(this.#closed)throw new ApiError(503,'Native files closed');
  if(Object.keys(params).some(key=>!['path','extended'].includes(key)))throw new ApiError(400,'Invalid directory arguments');
  if(params.path!==undefined&&params.path!=='gcodes'&&params.path!=='gcodes/')throw new ApiError(404,'Native directory not found');
  const extended=params.extended??false;if(typeof extended!=='boolean'&&(typeof extended!=='string'||!['true','false'].includes(extended.toLowerCase())))throw new ApiError(400,'Invalid extended flag');
  const signalOwned=AbortSignal.any([signal,this.#abort.signal]),entries=await this.#files.catalog(signalOwned),usage=await this.#files.diskUsage(signalOwned);signalOwned.throwIfAborted();
  const files=entries.map(({file,modified})=>{const filename=file.id+'.gcode',extra=extended===true||typeof extended==='string'&&extended.toLowerCase()==='true'?this.#metadata.peek(filename,file,modified):undefined;return {...extra,filename,modified,size:file.size,permissions:this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256};});
  const result={dirs:[],files,disk_usage:usage,root_info:{name:'gcodes',permissions:'rw'}};
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
  const result=entries.map(({file,modified})=>({path:file.id+'.gcode',modified,size:file.size,permissions:this.canRemove?'rw':'r',file_id:file.id,name:file.name,sha256:file.sha256}));
  if(Buffer.byteLength(JSON.stringify(result))>900000)throw new ApiError(413,'Native file catalog exceeds response limit');return result;
 }
 close():Promise<void>{this.#closed=true;this.#abort.abort(new ApiError(503,'Native uploads closed'));return Promise.all([Promise.allSettled([...this.#pending,...this.#downloads]),this.#metadata.close()]).then(()=>{});}
}
export function registerNativeFileInfo(registry:EndpointRegistry,uploads:NativePrintUploads,options:{metadata?:boolean}={}):()=>void{
 const release:(()=>void)[]=[];
 try{
  release.push(registry.register({endpoint:'/printer/files/info',methods:['GET']},(params,_verb,context)=>uploads.info(params,context.signal)));
  release.push(registry.register({endpoint:'/server/files/list',methods:['GET']},(params,_verb,context)=>uploads.list(params,context.signal)));
  release.push(registry.register({endpoint:'/server/files/delete_file',methods:['DELETE']},(params,_verb,context)=>uploads.remove(params,context)));
  release.push(registry.register({endpoint:'/server/files/directory',methods:['GET'],rpcVerbPrefix:true},(params,_verb,context)=>uploads.directory(params,context.signal)));
  if(options.metadata!==false){release.push(registry.register({endpoint:'/server/files/metadata',methods:['GET']},(params,_verb,context)=>uploads.metadata(params,context.signal)));release.push(registry.register({endpoint:'/server/files/thumbnails',methods:['GET']},(params,_verb,context)=>uploads.thumbnails(params,context.signal)));}
  return ()=>{for(const remove of release.reverse())remove();};
 }catch(error){for(const remove of release.reverse())remove();throw error;}
}
