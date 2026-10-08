import {mkdir,open,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {PublishedPrintFiles,type PublishedPrintFile,type PublishedSourceIdentity} from '../storage/published-files.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {MetadataLifecycle} from './metadata-lifecycle.ts';
import {MetadataExtractor} from './metadata-extractor.ts';
import {MetadataScanIntents} from './metadata-intents.ts';
import {MetadataSnapshots} from './metadata-snapshots.ts';
import {MetadataVersions} from './metadata-versions.ts';
import {ThumbnailProcessor} from './thumbnail-process.ts';
import {ThumbnailStorage} from './thumbnail-storage.ts';
import {FileMetadataStore,thumbnailPath} from './file-metadata.ts';
import {visibleFilePath} from '../storage/published-paths.ts';
import {nativeFilename} from './native-file-path.ts';
import {extractPublishedMetadata,samePublishedSource} from './native-metadata-source.ts';
import {ApiError,type Json,type RpcContext} from './rpc.ts';
import type {ThumbnailDownload} from './thumbnail-download.ts';
/** Owns the durable metadata protocol for the native receipt namespace. Writers
 * serialize; independent cache reads verify actual receipts within the same
 * bounded admission/close owner. Cached images remain disk-backed. */
export class NativePersistentMetadata {
 readonly #cache=new FileMetadataStore({maxRecords:128,maxBytes:8*1024**2,maxRecordBytes:256*1024});
 readonly #keys=new Map<string,PublishedSourceIdentity>();readonly #bundles=new Map<string,string>();
 readonly #invalidations=new Map<string,Promise<void>>();
 readonly #stop=new AbortController();readonly #pending=new Set<Promise<unknown>>();
 readonly #filenames=new Map<string,number>();
 #tail:Promise<unknown>=Promise.resolve();#closing:Promise<void>|undefined;#fault:unknown;#scans=0;#recovered=0;
 readonly #budget:PrintSnapshotBudget;readonly #life:MetadataLifecycle;
 private readonly files:PublishedPrintFiles;
 private readonly root:FileHandle;
 private readonly extractor:MetadataExtractor;
 private readonly processor:ThumbnailProcessor;
 private readonly images:ThumbnailStorage;
 private readonly intents:MetadataScanIntents;
 private readonly snapshots:MetadataSnapshots;
 private readonly versions:MetadataVersions;
 private constructor(files:PublishedPrintFiles,root:FileHandle,extractor:MetadataExtractor,processor:ThumbnailProcessor,images:ThumbnailStorage,intents:MetadataScanIntents,snapshots:MetadataSnapshots,versions:MetadataVersions){
  this.files=files;
  this.root=root;
  this.extractor=extractor;
  this.processor=processor;
  this.images=images;
  this.intents=intents;
  this.snapshots=snapshots;
  this.versions=versions;
  this.#budget=new PrintSnapshotBudget({maxBytes:files.status.maxFileBytes,maxSnapshots:2});
  this.#life=new MetadataLifecycle({extractor,processor,images,intents,snapshots,versions,cache:this.#cache,maxPending:4});
 }
 static async open(path:string,files:PublishedPrintFiles):Promise<NativePersistentMetadata>{
  if(!isAbsolute(path)||path.includes('\0')||files.status.closed)throw new Error('Invalid native metadata root');
  const closers:(()=>Promise<unknown>)[]=[];
  try{
   await mkdir(path,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});const root=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);closers.push(()=>root.close());
   const stat=await root.stat();if(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw new Error('Native metadata directory must be private and owned by service');const prefix=`/proc/self/fd/${root.fd}/`;
   const images=await ThumbnailStorage.open(prefix+'images',{maxCacheBytes:16*1024**2,maxStorageBytes:256*1024**2,maxBundles:4096});closers.push(()=>images.close());
   const intents=await MetadataScanIntents.open(prefix+'intents',{maxIntents:4096});closers.push(()=>intents.close());
   const snapshots=await MetadataSnapshots.open(prefix+'snapshots',{maxSnapshots:4096,maxStorageBytes:64*1024**2});closers.push(()=>snapshots.close());
   const versions=await MetadataVersions.open(prefix+'versions',{maxFiles:4096});closers.push(()=>versions.close());
   const extractor=await MetadataExtractor.open({maxPending:2,maxFileBytes:files.status.maxFileBytes});closers.push(()=>extractor.close());
   const processor=await ThumbnailProcessor.open({maxPending:2,maxQueuedBytes:4*1024**2});closers.push(()=>processor.close());
   const owner=new NativePersistentMetadata(files,root,extractor,processor,images,intents,snapshots,versions);closers.push(()=>owner.#life.close());
   const signal=owner.#stop.signal,paths=new Set((await files.catalog(signal)).map(entry=>visibleFilePath(entry.file)));
   for(const version of versions.entries())if(version.state!=='invalidated'&&(version.state==='pending'||!paths.has(version.filename)))await owner.#life.invalidate(version.filename,signal);
   for(const intent of intents.unresolved())if(!versions.current(intent.filename))await owner.#life.invalidate(intent.filename,signal);
   await owner.#life.retireSuperseded(signal);owner.#index();return owner;
  }catch(error){const failed:unknown[]=[error];for(const close of closers.reverse())try{await close();}catch(cleanup){failed.push(cleanup);}if(failed.length>1)throw new AggregateError(failed,'Native metadata startup cleanup failed');throw error;}
 }
 get status(){return {persistent:true,scans:this.#scans,recovered:this.#recovered,imageBytes:this.images.status.cacheBytes,imageBundles:this.images.status.cachedBundles,storedImageBytes:this.images.status.storage.storedBytes,pending:this.#pending.size,closed:this.#stop.signal.aborted,faulted:!!this.#fault,cache:this.#cache.status,snapshots:this.#budget.status};}
 #index(){this.#bundles.clear();const intents=new Map(this.intents.unresolved().map(i=>[i.id,i]));for(const version of this.versions.entries())if(version.state==='selected'){const intent=intents.get(version.scanId!);if(!intent)throw new Error('Selected metadata has no scan intent');this.#bundles.set(intent.bundleId,version.filename);}}
 #available(){return !this.#stop.signal.aborted&&!this.#fault&&!this.intents.status.faulted&&!this.snapshots.status.faulted&&!this.versions.status.faulted;}
 #admit<T>(operation:(earlier:Promise<unknown>)=>Promise<T>,filename:string,parallel=false):Promise<T>{
  if(!this.#available())return Promise.reject(new ApiError(503,'Native metadata requires recovery'));
  if(this.#pending.size>=4)return Promise.reject(new ApiError(503,'Native metadata queue full'));
  const earlier=this.#tail,task=(parallel?Promise.resolve():earlier).then(()=>operation(earlier));
  // Later writers still wait for every earlier accepted read. A parallel cache
  // miss falls back behind the captured earlier tail, never behind itself.
  this.#tail=parallel?Promise.allSettled([earlier,task]).then(()=>{}):task.catch(()=>{});this.#pending.add(task);this.#filenames.set(filename,(this.#filenames.get(filename)??0)+1);
  return task.finally(()=>{this.#pending.delete(task);const count=this.#filenames.get(filename)!-1;if(count)this.#filenames.set(filename,count);else this.#filenames.delete(filename);});
 }
 peek(filename:string,file:PublishedPrintFile,modified:number):Readonly<Record<string,Json>>|undefined{const value=this.#cache.peek(filename);return value?.sha256===file.sha256&&value?.name===file.name&&value?.modified===modified?value:undefined;}
 #drop(filename:string){this.#cache.invalidate(filename);this.#keys.delete(filename);}
 invalidate(filename:string):Promise<void>{
  this.#drop(filename);for(const [bundle,owner] of this.#bundles)if(owner===filename)this.#bundles.delete(bundle);
  const existing=this.#invalidations.get(filename);if(existing)return existing;
  const task=this.#admit(async()=>{if(this.versions.current(filename)?.state!=='invalidated'&&(this.versions.current(filename)||this.intents.unresolved().some(intent=>intent.filename===filename)))await this.#life.invalidate(filename,new AbortController().signal);await this.#life.retireSuperseded(new AbortController().signal,filename);this.#index();},filename).catch(error=>{this.#fault=error;throw error;}).finally(()=>this.#invalidations.delete(filename));
  this.#invalidations.set(filename,task);return task;
 }
 #room(){while(this.#keys.size&&(this.#keys.size>=128||this.#cache.status.bytes>this.#cache.status.maxBytes-this.#cache.status.maxRecordBytes-256)){this.#drop(this.#keys.keys().next().value!);}}
 metadata(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  return this.#request(filename,signal,false);
 }
 rescan(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  return this.#request(filename,signal,true);
 }
 #request(filename:string,signal:AbortSignal,force:boolean):Promise<Record<string,Json>>{
  try{nativeFilename(filename);}catch(error){return Promise.reject(error);}
  const combined=AbortSignal.any([signal,this.#stop.signal]),key=this.#keys.get(filename),snapshot=this.#cache.peek(filename),parallel=!force&&!this.#filenames.has(filename)&&!!key&&!!snapshot;
  return this.#admit(async earlier=>{
   if(parallel){const value=await this.#cached(filename,combined,key!,snapshot!);if(value)return value;return earlier.then(()=>this.#get(filename,combined,false));}
   return this.#get(filename,combined,force);
  },filename,parallel);
 }
 async #cached(filename:string,signal:AbortSignal,key:PublishedSourceIdentity,snapshot:Readonly<Record<string,Json>>):Promise<Record<string,Json>|undefined>{
  signal.throwIfAborted();let initial:Awaited<ReturnType<PublishedPrintFiles['describeSource']>>;
  try{const id=await this.files.resolvePath(filename,signal);initial=await this.files.describeSource(id,signal);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  signal.throwIfAborted();if(!this.#available())throw new ApiError(503,'Native metadata requires recovery');
  // A concurrent writer can evict/invalidate this cache entry while stat yields.
  // Changed bindings or cache tickets return to the original serial protocol.
  if(this.#keys.get(filename)!==key||this.#cache.peek(filename)!==snapshot||!samePublishedSource(key,initial.source)||!this.peek(filename,initial.file,initial.modified))return;
  this.#keys.delete(filename);this.#keys.set(filename,key);return this.#cache.metadata(filename);
 }
 async #get(filename:string,signal:AbortSignal,force:boolean):Promise<Record<string,Json>>{
  signal.throwIfAborted();let id:string,initial:Awaited<ReturnType<PublishedPrintFiles['describeSource']>>;
  try{id=await this.files.resolvePath(filename,signal);initial=await this.files.describeSource(id,signal);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.#drop(filename);throw new ApiError(404,'Published file not found');}throw error;}
  const key=this.#keys.get(filename);if(!force&&key&&samePublishedSource(key,initial.source)&&this.peek(filename,initial.file,initial.modified)){this.#keys.delete(filename);this.#keys.set(filename,key);return this.#cache.metadata(filename);}
  this.#drop(filename);this.#room();
  const validate=async(source:PublishedSourceIdentity,s:AbortSignal)=>{try{return samePublishedSource(source,(await this.files.describeSource(id,s)).source);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return false;throw error;}};
  let recovered=false;
  if(!force&&this.versions.current(filename)?.state==='selected'){
   // Recovery verifies bytes once, in addition to checking the durable receipt.
   const sealed=await this.files.acquireBinary(id,signal,this.#budget);await sealed.reader.close();
   if(initial.file.preview)await this.files.readPreview(id,signal,initial.file);
   try{recovered=await this.#life.recover(filename,signal,validate);}catch(error){if(!(error instanceof ApiError&&error.status===409&&error.message==='Metadata snapshot source changed'))throw error;}
  }
  if(recovered)this.#recovered++;
  else{const version=this.versions.current(filename);if(version){
    // A retained invalidation already durably revokes every prior selection.
    // Keep ordered retirement, but do not publish the same tombstone again
    // before allocating a fresh scan intent and pending generation.
    if(version.state!=='invalidated')await this.#life.invalidate(filename,signal);
    this.#index();await this.#life.retireSuperseded(signal,filename);
   }const result=await this.#life.scanExtraction(filename,signal,validate,()=>extractPublishedMetadata(this.files,this.#budget,this.extractor,id,signal));if(!result.committed)throw new ApiError(409,'Native metadata scan superseded');this.#scans++;}
  const current=await this.files.describeSource(id,signal);if(!samePublishedSource(initial.source,current.source)){this.#drop(filename);await this.#life.invalidate(filename,new AbortController().signal);throw new ApiError(409,'Native metadata receipt changed');}
  this.#keys.set(filename,current.source);await this.#life.retireSuperseded(signal,filename);this.#index();return this.#cache.metadata(filename);
 }
 async thumbnails(filename:string,signal:AbortSignal):Promise<Json[]>{await this.metadata(filename,signal);return this.#cache.thumbnails(filename);}
 #owner(path:string):string|undefined{
  if(!path.startsWith('/server/files/gcodes/'))return;let decoded:string;try{decoded=decodeURIComponent(path.slice('/server/files/gcodes/'.length));}catch{return;}
  const at=decoded.lastIndexOf('.thumbs/'),relative=decoded.slice(at),match=/^\.thumbs\/(thumb-[a-f0-9-]{36})\/(?:0|[1-9][0-9]?)\.(?:png|jpg)$/.exec(relative),filename=match&&this.#bundles.get(match[1]);
  return filename&&thumbnailPath(filename,relative)===decoded?filename:undefined;
 }
 hasThumbnail(path:string):boolean{return !!this.#owner(path);}
 async resolveThumbnail(path:string,context:RpcContext):Promise<ThumbnailDownload>{
  await context.authorize('server.files.download',{path});const filename=this.#owner(path);if(!filename)throw new ApiError(404,'Thumbnail not found');
  await context.authorize('server.files.download',{path,filename});await this.metadata(filename,context.signal);
  const download=await this.#life.thumbnailDownloads(()=>this.#stop.signal.throwIfAborted()).resolve(path,context),snapshot=this.#cache.peek(filename);
  const validate=async()=>{context.signal.throwIfAborted();this.#stop.signal.throwIfAborted();const current=await this.files.resolvePath(filename,context.signal).then(id=>this.files.describeSource(id,context.signal)).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Thumbnail source removed');throw error;});const source=this.#keys.get(filename);if(!source||this.#cache.peek(filename)!==snapshot||!samePublishedSource(source,current.source))throw new ApiError(404,'Thumbnail source changed');};
  await validate();return {...download,read:async()=>{await validate();const value=await download.read();await validate();return value;}};
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Native metadata closed'));this.#closing=(async()=>{await Promise.allSettled([...this.#pending]);await this.#life.close();const results=await Promise.allSettled([this.extractor.close(),this.processor.close(),this.images.close(),this.intents.close(),this.snapshots.close(),this.versions.close()]);this.#cache.clear();this.#keys.clear();this.#bundles.clear();try{await this.root.close();}catch(error){results.push({status:'rejected',reason:error});}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Native metadata close failed');})();return this.#closing;}
}
