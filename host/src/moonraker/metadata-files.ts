import {constants} from 'node:fs';
import {open,type FileHandle} from 'node:fs/promises';
import {extname,isAbsolute} from 'node:path';
import {ApiError,type Json} from './rpc.ts';
import {validateMetadataFilename} from './file-metadata.ts';
import type {MetadataLifecycle} from './metadata-lifecycle.ts';
import type {MetadataExtraction} from './metadata-extractor.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface MetadataFilesOptions {root:string;lifecycle:MetadataLifecycle;maxPending?:number;}
/** Linux descriptor-anchored G-code access. Root and all child components reject
 * symlinks at each open. The configured root's ancestors are trusted. The caller
 * owns lifecycle; close this admission layer before closing its dependencies. */
export class MetadataFiles {
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
 get downloads(){return this.#options.lifecycle.thumbnailDownloads();}
 metadata(filename:string){return this.#options.lifecycle.metadata(filename);}
 thumbnails(filename:string){return this.#options.lifecycle.thumbnails(filename);}
 #name(filename:string):void{
  try{validateMetadataFilename(filename);}catch{throw new ApiError(400,'Invalid metadata filename');}
  const parts=filename.split('/');if(parts.length>64)throw new ApiError(400,'Metadata path is too deep');
  if(parts.includes('.git'))throw new ApiError(403,'Reserved metadata path');
  const extension=extname(filename);if(extension==='.ufp')throw new ApiError(501,'UFP metadata extraction is not implemented');
  if(!['.gcode','.g','.gco','.nc'].includes(extension))throw new ApiError(400,'Not a valid gcode file');
 }
 async #source(filename:string,signal:AbortSignal):Promise<FileHandle>{
  let parent=this.#root,owned:FileHandle|undefined;
  try{
   const parts=filename.split('/');
   for(let i=0;i<parts.length;i++){
    signal.throwIfAborted();const last=i===parts.length-1;
    const next=await open(`/proc/self/fd/${parent.fd}/${parts[i]}`,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK|(last?0:constants.O_DIRECTORY));
    try{await owned?.close();}catch(error){await next.close();throw error;}
    owned=next;parent=next;
   }
   signal.throwIfAborted();if(!(await owned!.stat()).isFile())throw new ApiError(400,'Metadata source is not a regular file');
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
  return this.#admit(signal,()=>this.#name(filename),async combined=>{
   const source=await this.#source(filename,combined);
   const result=await this.#options.lifecycle.scan(filename,source,combined,(value,s)=>this.#validate(filename,value,s));
   combined.throwIfAborted();if(!result.committed)throw new ApiError(409,'Metadata scan was superseded');
   try{return this.#options.lifecycle.metadata(filename);}catch(error){if(error instanceof ApiError&&error.status===404)throw new ApiError(409,'Metadata scan was superseded');throw error;}
  });
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
 close():Promise<void>{if(this.#closing)return this.#closing;this.#stop.abort(new ApiError(503,'Metadata files are closing'));this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#root.close());return this.#closing;}
}
export function registerFileMetascan(registry:EndpointRegistry,files:MetadataFiles):()=>void{
 return registry.register({endpoint:'/server/files/metascan',methods:['POST']},(params,_verb,context)=>{
  if(typeof params.filename!=='string')throw new ApiError(400,'Unable to extract argument [filename] as string');
  return files.rescan(params.filename,context.signal);
 });
}
