import {PublishedPrintFiles,type PublishedPrintFile} from '../storage/published-files.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {createHash,randomUUID} from 'node:crypto';
import {ThumbnailProcessor} from './thumbnail-process.ts';
import type {ThumbnailImage} from './thumbnail-images.ts';
import {ThumbnailDownloads,type ThumbnailDownload} from './thumbnail-download.ts';
import {MetadataExtractor} from './metadata-extractor.ts';
import {METADATA_READ_BYTES} from './metadata-window.ts';
import {FileMetadataStore} from './file-metadata.ts';
import {ApiError,type Json,type RpcContext} from './rpc.ts';
const identity=(file:PublishedPrintFile,modified:number)=>JSON.stringify([file.sha256,file.name,file.size,modified]);
/** Metadata and bounded derived previews for the immutable native namespace. Worker parsing shares the
 * existing slicer implementations; verified byte windows do not retain memfd leases. */
export class NativeFileMetadata {
 readonly #files:PublishedPrintFiles;readonly #budget:PrintSnapshotBudget;
 readonly #cache=new FileMetadataStore({maxRecords:128,maxBytes:8*1024**2,maxRecordBytes:256*1024});
 readonly #keys=new Map<string,string>();readonly #pending=new Set<Promise<unknown>>();readonly #stop=new AbortController();
 readonly #bundles=new Map<string,{filename:string;key:string;images:(ThumbnailImage&{sha256:string})[];bytes:number}>();
 readonly #fileBundles=new Map<string,string>();readonly #downloads:ThumbnailDownloads;
 #imageBytes=0;#processor:Promise<ThumbnailProcessor>|undefined;
 #worker:Promise<MetadataExtractor>|undefined;#closing:Promise<void>|undefined;
 constructor(files:PublishedPrintFiles){this.#downloads=new ThumbnailDownloads({read:(id,index,signal,maxBytes)=>this.#readImage(id,index,signal,maxBytes)},this.#cache,()=>this.#stop.signal.throwIfAborted());this.#files=files;this.#budget=new PrintSnapshotBudget({maxBytes:files.status.maxFileBytes,maxSnapshots:2});}
 get status(){return {imageBytes:this.#imageBytes,imageBundles:this.#bundles.size,pending:this.#pending.size,closed:this.#stop.signal.aborted,cache:this.#cache.status,snapshots:this.#budget.status};}
 peek(filename:string,file:PublishedPrintFile,modified:number):Readonly<Record<string,Json>>|undefined{return this.#keys.get(filename)===identity(file,modified)?this.#cache.peek(filename):undefined;}
 invalidate(filename:string):void{this.#drop(filename);}
 #drop(filename:string):void{const id=this.#fileBundles.get(filename);if(id){const bundle=this.#bundles.get(id);if(bundle)this.#imageBytes-=bundle.bytes;this.#bundles.delete(id);this.#fileBundles.delete(filename);}this.#cache.invalidate(filename);this.#keys.delete(filename);}
 hasThumbnail(path:string):boolean{try{return !!this.#cache.thumbnailOwner(decodeURIComponent(path.slice('/server/files/gcodes/'.length)));}catch{return false;}}
 async #validateThumbnail(filename:string,snapshot:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();this.#stop.signal.throwIfAborted();
  try{const current=await this.#files.describe(filename.slice(0,-6),signal);if(this.#cache.peek(filename)!==snapshot||!this.peek(filename,current.file,current.modified))throw new ApiError(404,'Native thumbnail reference changed');}
  catch(error){if((error instanceof ApiError&&error.status===404||(error as NodeJS.ErrnoException)?.code==='ENOENT')&&this.#cache.peek(filename)===snapshot)this.#drop(filename);if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Native thumbnail source removed');throw error;}
 }
 async #readImage(id:string,index:number,signal:AbortSignal,maxBytes=8*1024**2){
  signal.throwIfAborted();this.#stop.signal.throwIfAborted();const bundle=this.#bundles.get(id),image=bundle?.images[index];
  if(!bundle||!image||!Number.isSafeInteger(index)||index<0)throw new ApiError(404,'Native thumbnail unavailable');
  if(image.bytes.length>maxBytes)throw new ApiError(413,'Native thumbnail read budget exceeded');
  return {bytes:Buffer.from(image.bytes),sha256:image.sha256,width:image.width,height:image.height,contentType:image.format==='png'?'image/png':'image/jpeg'};
 }
 async resolveThumbnail(path:string,context:RpcContext):Promise<ThumbnailDownload>{
  const resolved=await this.#downloads.resolve(path,context),owner=this.#cache.thumbnailOwner(decodeURIComponent(path.slice('/server/files/gcodes/'.length)));
  if(!owner)throw new ApiError(404,'Native thumbnail reference changed');await this.#validateThumbnail(owner.filename,owner.snapshot,context.signal);
  return {...resolved,read:async()=>{await this.#validateThumbnail(owner.filename,owner.snapshot,context.signal);const result=await resolved.read();await this.#validateThumbnail(owner.filename,owner.snapshot,context.signal);return result;}};
 }
 async thumbnails(filename:string,signal:AbortSignal):Promise<Json[]>{await this.metadata(filename,signal);signal.throwIfAborted();return this.#cache.thumbnails(filename);}
 metadata(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  if(this.#stop.signal.aborted)return Promise.reject(new ApiError(503,'Native metadata closed'));
  if(!/^[A-Za-z0-9_-]{1,128}\.gcode$/.test(filename))return Promise.reject(new ApiError(400,'Invalid native metadata filename'));
  if(this.#pending.size>=2)return Promise.reject(new ApiError(503,'Native metadata queue full'));
  const combined=AbortSignal.any([signal,this.#stop.signal]);const task=this.#extract(filename,combined);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 async #extract(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  signal.throwIfAborted();const id=filename.slice(0,-6);
  try{
   const initial=await this.#files.describe(id,signal),key=identity(initial.file,initial.modified),cached=this.peek(filename,initial.file,initial.modified);
   if(cached){this.#keys.delete(filename);this.#keys.set(filename,key);return this.#cache.metadata(filename);}
   const snapshot=await this.#files.acquireBinary(id,signal,this.#budget);let head:Buffer,tail:Buffer;
   try{
    if(identity(snapshot.record,initial.modified)!==key)throw new ApiError(409,'Native metadata source changed');
    const read=async(start:number,end:number)=>{const bytes=Buffer.allocUnsafe(end-start);let offset=0;for await(const chunk of snapshot.reader.chunks(signal,start,end)){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;};
    head=await read(0,Math.min(snapshot.size,METADATA_READ_BYTES));const offset=snapshot.size>2*METADATA_READ_BYTES?snapshot.size-METADATA_READ_BYTES:METADATA_READ_BYTES;
    tail=snapshot.size>METADATA_READ_BYTES?await read(offset,snapshot.size):Buffer.alloc(0);
   }finally{await snapshot.reader.close();}
   signal.throwIfAborted();const worker=await(this.#worker??=MetadataExtractor.open({maxPending:2,maxFileBytes:this.#files.status.maxFileBytes}));signal.throwIfAborted();
   const result=await worker.extractWindows({head,tail,size:initial.file.size,modified:initial.modified},signal,true);signal.throwIfAborted();
   if(typeof result.thumbnailData!=='string')throw new ApiError(502,'Thumbnail extraction omitted source');
   let images:ThumbnailImage[]=[];
   if(result.thumbnailData){const processor=await(this.#processor??=ThumbnailProcessor.open({maxPending:2,maxQueuedBytes:4*1024**2}));signal.throwIfAborted();images=await processor.prepare(result.thumbnailData,signal);signal.throwIfAborted();}
   const current=await this.#files.describe(id,signal);if(identity(current.file,current.modified)!==key)throw new ApiError(409,'Native metadata source changed');
   // Concurrent cold readers must share the already published preview URLs.
   if(this.peek(filename,current.file,current.modified))return this.#cache.metadata(filename);
   const bundleId='thumb-'+randomUUID(),prepared=images.map(image=>({...image,sha256:createHash('sha256').update(image.bytes).digest('hex')})),imageBytes=prepared.reduce((total,image)=>total+image.bytes.length,0);
   const thumbnails=prepared.map((image,index)=>({width:image.width,height:image.height,size:image.bytes.length,relative_path:'.thumbs/'+bundleId+'/'+index+'.'+image.format}));
   const fields={...result.fields,file_id:id,sha256:initial.file.sha256,name:initial.file.name,thumbnails};
   this.#drop(filename);
   const needed=Buffer.byteLength(JSON.stringify(fields))+Buffer.byteLength(filename);
   while(this.#keys.size&&(this.#keys.size>=128||this.#cache.status.bytes+needed>this.#cache.status.maxBytes||this.#imageBytes+imageBytes>16*1024**2)){const oldest=this.#keys.keys().next().value!;this.#drop(oldest);}
   const ticket=this.#cache.begin(filename);try{this.#cache.commit(ticket,fields);}catch(error){this.#cache.fail(ticket);throw error;}this.#keys.set(filename,key);if(prepared.length){this.#bundles.set(bundleId,{filename,key,images:prepared,bytes:imageBytes});this.#fileBundles.set(filename,bundleId);this.#imageBytes+=imageBytes;}return this.#cache.metadata(filename);
  }catch(error){if((error as NodeJS.ErrnoException)?.code==='ENOENT')throw new ApiError(404,'Published file not found');if(error instanceof Error&&error.message==='Print snapshot quota exceeded')throw new ApiError(503,'Native metadata snapshot capacity exceeded');throw error;}
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Native metadata closed'));this.#closing=(async()=>{await Promise.allSettled([this.#worker?.then(worker=>worker.close(),()=>{}),this.#processor?.then(processor=>processor.close(),()=>{})]);await Promise.allSettled([...this.#pending]);this.#cache.clear();this.#keys.clear();this.#bundles.clear();this.#fileBundles.clear();this.#imageBytes=0;})();return this.#closing;}
}
