import {workerEntry} from '../runtime/worker-entry.ts';
import {Worker} from 'node:worker_threads';
import type {FileHandle} from 'node:fs/promises';
import {ApiError,type Json} from './rpc.ts';
import {FileMetadataStore} from './file-metadata.ts';
export interface MetadataExtraction {thumbnailData?:string;fields:Record<string,Json>;source:{dev:bigint;ino:bigint;mtimeNs:bigint;ctimeNs:bigint};objects:{hasObjects:boolean;hasM486Objects:boolean};}
export interface MetadataExtractorOptions {maxPending?:number;timeoutMs?:number;maxFileBytes?:number;maxOutputBytes?:number;}
export interface MetadataFieldExtraction {thumbnailData?:string;fields:Record<string,Json>;objects:MetadataExtraction['objects'];}
export interface MetadataByteWindows {head:Uint8Array;tail:Uint8Array;size:number;modified:number;}
interface Pending {cancel:Int32Array;finish:(error:unknown,value?:MetadataExtraction|MetadataFieldExtraction)=>void;dispose:()=>void;}
/** Transfers admitted FileHandles to a serial, bounded Worker. A timeout fences the
 * whole instance; create a new instance explicitly after handling the fault. */
export class MetadataExtractor {
 #worker:Worker;#pending=new Map<number,Pending>();#next=0;#closed=false;#closing:Promise<void>|undefined;#options:Required<MetadataExtractorOptions>;
 private constructor(options:Required<MetadataExtractorOptions>){this.#options=options;this.#worker=new Worker(workerEntry('./metadata-extractor-worker.ts',import.meta.url),{workerData:options,execArgv:[],resourceLimits:{maxOldGenerationSizeMb:128,maxYoungGenerationSizeMb:16,stackSizeMb:4}});}
 static async open(input:MetadataExtractorOptions={}):Promise<MetadataExtractor>{
  const options={maxPending:input.maxPending??4,timeoutMs:input.timeoutMs??5000,maxFileBytes:input.maxFileBytes??16*1024**3,maxOutputBytes:input.maxOutputBytes??256*1024};
  for(const [name,max,min] of [['maxPending',64,1],['timeoutMs',60000,1],['maxFileBytes',1024**4,0],['maxOutputBytes',1024**2,1]] as const)if(!Number.isSafeInteger(options[name])||options[name]<min||options[name]>max)throw new RangeError('Invalid metadata extraction capacity');
  const instance=new MetadataExtractor(options),ready=Promise.withResolvers<void>();
  instance.#worker.on('error',error=>{ready.reject(error);instance.#fail(error);});
  instance.#worker.on('exit',()=>{const error=new ApiError(503,'Metadata extraction worker exited');ready.reject(error);instance.#fail(error);});
  instance.#worker.on('message',message=>{
   if(message.ready){ready.resolve();return;}
   const pending=instance.#pending.get(message.id);if(!pending)return;
   instance.#pending.delete(message.id);pending.dispose();pending.finish(message.error?new ApiError(message.error.code,message.error.message):undefined,message.value);
  });
  const timer=setTimeout(()=>ready.reject(new ApiError(504,'Metadata extraction startup timed out')),Math.max(1000,options.timeoutMs));
  try{await ready.promise;return instance;}catch(error){await instance.close();throw error;}finally{clearTimeout(timer);}
 }
 get pendingRequests():number{return this.#pending.size;}
 get closed():boolean{return this.#closed;}
 /** On admission postMessage transfers ownership. Rejected admission leaves the handle
  * with the caller; successful admission closes it in the Worker even on cancellation. */
 extract(source:FileHandle,signal:AbortSignal,includeThumbnailData=false):Promise<MetadataExtraction>{
  return this.#submit(source,undefined,signal,includeThumbnailData).then(value=>{if(!('source' in value))throw new ApiError(502,'Metadata extraction omitted source');return value;});
 }
 extractWindows(window:MetadataByteWindows,signal:AbortSignal,includeThumbnailData=false):Promise<MetadataFieldExtraction>{
  if(!window||!(window.head instanceof Uint8Array)||!(window.tail instanceof Uint8Array)||!Number.isSafeInteger(window.size)||window.size<0||window.size>this.#options.maxFileBytes||!Number.isFinite(window.modified)||window.head.byteLength!==Math.min(window.size,1024**2)||window.tail.byteLength!==Math.max(0,Math.min(window.size-1024**2,1024**2)))return Promise.reject(new TypeError('Invalid metadata byte windows'));
  return this.#submit(undefined,window,signal,includeThumbnailData);
 }
 #submit(source:FileHandle|undefined,window:MetadataByteWindows|undefined,signal:AbortSignal,includeThumbnailData:boolean):Promise<MetadataExtraction|MetadataFieldExtraction>{
  if(typeof includeThumbnailData!=='boolean')return Promise.reject(new TypeError('Invalid thumbnail extraction option'));
  if(this.#closed)return Promise.reject(new ApiError(503,'Metadata extractor is closed'));
  if(signal.aborted)return Promise.reject(signal.reason);
  if(!window&&(!source||!Number.isInteger(source.fd)||source.fd<0))return Promise.reject(new TypeError('Invalid metadata source handle'));
  if(this.#pending.size>=this.#options.maxPending||this.#next===Number.MAX_SAFE_INTEGER)return Promise.reject(new ApiError(503,'Metadata extraction queue is full'));
  const id=++this.#next,cancel=new Int32Array(new SharedArrayBuffer(4)),result=Promise.withResolvers<MetadataExtraction|MetadataFieldExtraction>();let settled=false;
  const finish=(error:unknown,value?:MetadataExtraction|MetadataFieldExtraction)=>{if(settled)return;settled=true;if(error!==undefined)result.reject(error);else if(signal.aborted)result.reject(signal.reason);else result.resolve(value!);};
  const abort=()=>{Atomics.store(cancel,0,1);finish(signal.reason??new ApiError(499,'Metadata extraction cancelled'));};
  const timer=setTimeout(()=>{this.#fail(new ApiError(504,'Metadata extraction timed out'));void this.close();},this.#options.timeoutMs);
  const dispose=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  this.#pending.set(id,{cancel,finish,dispose});signal.addEventListener('abort',abort,{once:true});
  try{this.#worker.postMessage({id,source,window,cancel:cancel.buffer,includeThumbnailData},source?[source]:[]);}catch(error){this.#pending.delete(id);dispose();finish(error);}
  return result.promise;
 }
 #fail(error:unknown):void{this.#closed=true;for(const pending of this.#pending.values()){Atomics.store(pending.cancel,0,1);pending.finish(error);pending.dispose();}this.#pending.clear();}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#fail(new ApiError(503,'Metadata extractor is closed'));this.#closing=this.#worker.terminate().then(()=>{});return this.#closing;}
}
/** The caller authorizes filename↔descriptor and invalidates tickets on every source
 * change. This helper neither watches the filesystem nor generates image metadata. */
export async function scanMetadataFields(extractor:MetadataExtractor,store:FileMetadataStore,filename:string,source:FileHandle,signal:AbortSignal):Promise<boolean>{
 const ticket=store.begin(filename);
 try{const value=await extractor.extract(source,signal);signal.throwIfAborted();return store.commit(ticket,value.fields);}catch(error){store.fail(ticket);throw error;}
}
