import {MetadataDirectoryWatches} from './metadata-watch.ts';
import {constants} from 'node:fs';
import {open,opendir,type FileHandle} from 'node:fs/promises';
import {extname,isAbsolute} from 'node:path';
import {ApiError,type Json} from './rpc.ts';
import {validateMetadataFilename} from './file-metadata.ts';
import type {MetadataLifecycle} from './metadata-lifecycle.ts';
import type {MetadataExtraction} from './metadata-extractor.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface MetadataObservation {():void;healthy():void;fault():void;}
export interface MetadataFilesOptions {root:string;lifecycle:MetadataLifecycle;maxPending?:number;}
/** Linux descriptor-anchored G-code access. Root and all child components reject
 * symlinks at each open. The configured root's ancestors are trusted. The caller
 * owns lifecycle; close this admission layer before closing its dependencies. */
export class MetadataFiles {
 #observationReadable=true;
 #observation:MetadataDirectoryWatches|undefined;#discovering=false;
 #root:FileHandle;#options:MetadataFilesOptions;#limit:number;#pending=new Set<Promise<unknown>>();#stop=new AbortController();#closing:Promise<void>|undefined;
 private constructor(root:FileHandle,options:MetadataFilesOptions,limit:number){this.#root=root;this.#options={...options};this.#limit=limit;}
 static async open(options:MetadataFilesOptions):Promise<MetadataFiles>{
  const limit=options.maxPending??4;
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)throw new RangeError('Invalid metadata file capacity');
  if(typeof options.root!=='string'||!options.root.isWellFormed()||!isAbsolute(options.root)||options.root.includes('\0')||Buffer.byteLength(options.root)>4096)throw new TypeError('Invalid metadata root');
  const root=await open(options.root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  return new MetadataFiles(root,options,limit);
 }
 get status(){return {closed:this.#stop.signal.aborted,pending:this.#pending.size,maxPending:this.#limit};}
 observe(change:()=>void,error:(error:Error)=>void,maxDirectories=1024):MetadataObservation{if(this.#stop.signal.aborted||this.#observation)throw new Error('Metadata observation is closed or already owned');const observer=new MetadataDirectoryWatches(this.#root,change,error,maxDirectories);this.#observation=observer;this.#observationReadable=false;const release=()=>{observer.close();if(this.#observation===observer){this.#observation=undefined;this.#observationReadable=false;}};return Object.assign(release,{healthy:()=>{if(this.#observation===observer)this.#observationReadable=true;},fault:()=>{if(this.#observation===observer)this.#observationReadable=false;}});}
 #assertReadable(){if(this.#stop.signal.aborted||!this.#observationReadable)throw new ApiError(503,'File metadata monitoring is unavailable');}
 get watchedDirectories(){return this.#observation?.count??0;}
 get downloads(){return this.#options.lifecycle.thumbnailDownloads(()=>this.#assertReadable());}
 historyMetadata(filename:string){this.#assertReadable();return this.#options.lifecycle.historyMetadata(filename);}
 metadata(filename:string){this.#assertReadable();return this.#options.lifecycle.metadata(filename);}
 thumbnails(filename:string){this.#assertReadable();return this.#options.lifecycle.thumbnails(filename);}
 #name(filename:string):void{
  try{validateMetadataFilename(filename);}catch{throw new ApiError(400,'Invalid metadata filename');}
  const parts=filename.split('/');if(parts.length>64)throw new ApiError(400,'Metadata path is too deep');
  if(parts.includes('.git'))throw new ApiError(403,'Reserved metadata path');
  const extension=extname(filename);if(extension==='.ufp')throw new ApiError(501,'UFP metadata extraction is not implemented');
  if(!['.gcode','.g','.gco','.nc'].includes(extension))throw new ApiError(400,'Not a valid gcode file');
 }
 async #source(filename:string,signal:AbortSignal,directory=false):Promise<FileHandle>{
  let parent=this.#root,owned:FileHandle|undefined;
  try{
   const parts=filename.split('/');
   for(let i=0;i<parts.length;i++){
    signal.throwIfAborted();const last=i===parts.length-1;
    const next=await open(`/proc/self/fd/${parent.fd}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(!last||directory?constants.O_DIRECTORY:0));
    try{await owned?.close();}catch(error){await next.close();throw error;}
    owned=next;parent=next;
   }
   signal.throwIfAborted();const status=await owned!.stat();if(directory?!status.isDirectory():!status.isFile())throw new ApiError(400,'Metadata source has an invalid type');
   const source=owned!;owned=undefined;return source;
  }catch(error){
   if(['ENOENT','ENOTDIR','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))throw new ApiError(404,'G-code file unavailable or symlink forbidden');throw error;
  }finally{await owned?.close();}
 }
 async #validate(filename:string,expected:MetadataExtraction['source'],signal:AbortSignal):Promise<boolean>{
  let source:FileHandle|undefined;
  try{source=await this.#source(filename,signal);const actual=await source.stat({bigint:true});signal.throwIfAborted();return actual.dev===expected.dev&&actual.ino===expected.ino&&actual.mtimeNs===expected.mtimeNs&&actual.ctimeNs===expected.ctimeNs;}
  catch(error){if(error instanceof ApiError&&[400,404].includes(error.status))return false;throw error;}
  finally{await source?.close();}
 }
 #admit<T>(signal:AbortSignal,validate:()=>void,operation:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  try{if(this.#stop.signal.aborted)throw new ApiError(503,'Metadata files are closed');signal.throwIfAborted();validate();if(this.#pending.size>=this.#limit)throw new ApiError(503,'Metadata file queue is full');}catch(error){return Promise.reject(error);}
  const combined=AbortSignal.any([signal,this.#stop.signal]);
  const task=Promise.resolve().then(()=>{combined.throwIfAborted();return operation(combined);});
  this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 rescan(filename:string,signal:AbortSignal):Promise<Record<string,Json>>{
  return this.#admit(signal,()=>this.#name(filename),combined=>this.#scan(filename,combined));
 }
 /** Apply a confirmed file-change hint: revoke durable/public old state first,
  * reclaim only that filename's superseded scans, then read the current source.
  * Failure leaves old data unavailable; no rollback to stale metadata. */
 refresh(filename:string,signal:AbortSignal):Promise<{state:'updated';metadata:Record<string,Json>}|{state:'unavailable'}>{
  return this.#admit(signal,()=>this.#name(filename),s=>this.#refresh(filename,s));
 }
 async #refresh(filename:string,s:AbortSignal):Promise<{state:'updated';metadata:Record<string,Json>}|{state:'unavailable'}>{
   const owner=this.#options.lifecycle;await owner.invalidate(filename,s);await owner.retireSuperseded(s,filename);s.throwIfAborted();
   try{return {state:'updated',metadata:await this.#scan(filename,s)};}catch(error){s.throwIfAborted();if(error instanceof ApiError&&[400,404].includes(error.status))return {state:'unavailable'};throw error;}
 }
 async #scan(filename:string,combined:AbortSignal):Promise<Record<string,Json>>{
   const source=await this.#source(filename,combined);
   const result=await this.#options.lifecycle.scan(filename,source,combined,(value,s)=>this.#validate(filename,value,s));
   combined.throwIfAborted();if(!result.committed)throw new ApiError(409,'Metadata scan was superseded');
   try{return this.#options.lifecycle.metadata(filename);}catch(error){if(error instanceof ApiError&&error.status===404)throw new ApiError(409,'Metadata scan was superseded');throw error;}
 }
 async #recover(filename:string,signal:AbortSignal):Promise<boolean>{
  let changed=false;
  try{return await this.#options.lifecycle.recover(filename,signal,async(value,s)=>{const valid=await this.#validate(filename,value,s);if(!valid)changed=true;return valid;});}
  catch(error){signal.throwIfAborted();if(changed&&error instanceof ApiError&&error.status===409)return false;throw error;}
 }
 recover(filename:string,signal:AbortSignal):Promise<boolean>{return this.#admit(signal,()=>this.#name(filename),s=>this.#recover(filename,s));}
 /** Snapshot selected names only; no fallback or discovery of unscanned files.
  * Stop on corruption/IO failure. Earlier successful records remain available. */
 restoreSelected(signal:AbortSignal):Promise<{restored:number;unavailable:number}>{
  return this.#admit(signal,()=>{},async s=>{const names=this.#options.lifecycle.selectedFilenames();let restored=0,unavailable=0;for(const filename of names){s.throwIfAborted();this.#name(filename);if(await this.#recover(filename,s))restored++;else unavailable++;}s.throwIfAborted();return {restored,unavailable};});
 }
 /** Enumerate completely before scanning, with bounded names and traversal.
  * Symlinks and private directories are skipped; each admitted source is reopened
  * from the anchored root before use. Discovery is not a directory snapshot. */
 scanDiscovered(signal:AbortSignal,limits:{maxEntries?:number;maxFiles?:number;maxBytes?:number}={}):Promise<{restored:number;scanned:number;unavailable:number;unsupported:number}>{
  const maxEntries=limits.maxEntries??65536,maxFiles=limits.maxFiles??1024,maxBytes=limits.maxBytes??4*1024**2;
  return this.#admit(signal,()=>{for(const [value,max] of [[maxEntries,262144],[maxFiles,4096],[maxBytes,8*1024**2]])if(!Number.isSafeInteger(value)||value<1||value>max)throw new RangeError('Invalid metadata discovery capacity');},async s=>{
   if(this.#discovering)throw new ApiError(503,'Metadata discovery already running');this.#discovering=true;try{
   const observer=this.#observation,seen=new Set<string>();const names:string[]=[];let entries=0,bytes=0,unsupported=0;
   const walk=async(relative:string,depth:number):Promise<void>=>{
    s.throwIfAborted();if(depth>64)throw new ApiError(413,'Metadata directory depth exceeded');
    const source=await this.#source(relative||'.',s,true);
    try{seen.add(relative);await observer?.touch(relative,source);const directory=await opendir(`/proc/self/fd/${source.fd}`,{encoding:'buffer' as BufferEncoding,bufferSize:32});
     try{for(let entry=await directory.read();entry;entry=await directory.read()){
      s.throwIfAborted();if(++entries>maxEntries)throw new ApiError(413,'Metadata discovery entry limit exceeded');
      const name=Buffer.isBuffer(entry.name)?new TextDecoder('utf-8',{fatal:true}).decode(entry.name):entry.name;
      if(name==='.git'||name==='.thumbs'||entry.isSymbolicLink())continue;
      const path=relative?relative+'/'+name:name;if(Buffer.byteLength(path)>4096)throw new ApiError(413,'Metadata discovery path limit exceeded');
      if(entry.isDirectory()){await walk(path,depth+1);continue;}if(!entry.isFile())continue;
      const extension=extname(name);if(extension==='.ufp'){unsupported++;continue;}if(!['.gcode','.g','.gco','.nc'].includes(extension))continue;
      this.#name(path);bytes+=Buffer.byteLength(path);if(names.length>=maxFiles||bytes>maxBytes)throw new ApiError(413,'Metadata discovery file capacity exceeded');names.push(path);
     }}finally{await directory.close();}
    }finally{await source.close();}
   };
   await walk('',0);observer?.retain(seen);
   // Include active durable names absent from this enumeration. Their source is
   // reopened below: absence from the directory list alone never authorizes deletion.
   const included=new Set(names);for(const name of this.#options.lifecycle.activeFilenames()){
    s.throwIfAborted();if(included.has(name))continue;this.#name(name);bytes+=Buffer.byteLength(name);
    if(names.length>=maxFiles||bytes>maxBytes)throw new ApiError(413,'Metadata reconciliation capacity exceeded');names.push(name);included.add(name);
   }
   // Finish interrupted retirement before admitting replacement scans. Unknown
   // intents without a version are intentionally retained by the lifecycle owner.
   await this.#options.lifecycle.retireSuperseded(s);let restored=0,scanned=0,unavailable=0;
   for(const name of names){s.throwIfAborted();if(await this.#recover(name,s)){restored++;continue;}
    const result=await this.#refresh(name,s);if(result.state==='updated')scanned++;else unavailable++;
   }
   s.throwIfAborted();return {restored,scanned,unavailable,unsupported};
   }finally{this.#discovering=false;}
  });
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#observation?.close();this.#observation=undefined;this.#stop.abort(new ApiError(503,'Metadata files are closing'));this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#root.close());return this.#closing;}
}
export function registerFileMetascan(registry:EndpointRegistry,files:MetadataFiles):()=>void{
 return registry.register({endpoint:'/server/files/metascan',methods:['POST']},(params,_verb,context)=>{
  if(typeof params.filename!=='string')throw new ApiError(400,'Unable to extract argument [filename] as string');
  return files.rescan(params.filename,context.signal);
 });
}
