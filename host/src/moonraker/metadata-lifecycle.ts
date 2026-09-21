import type {FileHandle} from 'node:fs/promises';
import {ApiError} from './rpc.ts';
import {FileMetadataStore,validateMetadataFilename} from './file-metadata.ts';
import type {MetadataExtractor,MetadataExtraction} from './metadata-extractor.ts';
import type {ThumbnailProcessor} from './thumbnail-process.ts';
import type {ThumbnailStorage} from './thumbnail-storage.ts';
import type {MetadataScanIntents,MetadataScanIntent} from './metadata-intents.ts';
import type {MetadataSnapshots} from './metadata-snapshots.ts';
import type {MetadataVersions,MetadataVersion} from './metadata-versions.ts';
import {scanFileMetadata} from './metadata-scan.ts';
import {MetadataIntentScanError} from './metadata-intent-scan.ts';
import {restoreCurrentMetadata} from './metadata-version-recovery.ts';
import {retireMetadataScan} from './metadata-retirement.ts';
export interface MetadataLifecycleOptions {
 extractor:MetadataExtractor;processor:ThumbnailProcessor;images:ThumbnailStorage;intents:MetadataScanIntents;snapshots:MetadataSnapshots;versions:MetadataVersions;cache:FileMetadataStore;maxPending?:number;
}
export interface MetadataLifecycleScan {committed:boolean;intent:MetadataScanIntent;snapshotId:string|null;version:MetadataVersion|null;}
const ownedComponents=new WeakSet<object>();
type Validate=(source:MetadataExtraction['source'],signal:AbortSignal)=>Promise<boolean>;
/** Sole lifecycle writer for the borrowed components. Accepted state transitions,
 * recovery and retirement serialize; file IO/validation callbacks must honor their
 * signal. Close drains accepted work and does not close borrowed components. */
export class MetadataLifecycle {
 #components:object[];#options:MetadataLifecycleOptions;#maxPending:number;#tail:Promise<unknown>=Promise.resolve();#pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;
 constructor(options:MetadataLifecycleOptions){this.#maxPending=options.maxPending??4;if(!Number.isSafeInteger(this.#maxPending)||this.#maxPending<1||this.#maxPending>16)throw new RangeError('Invalid metadata lifecycle capacity');this.#components=[options.extractor,options.processor,options.images,options.intents,options.snapshots,options.versions,options.cache];if(this.#components.some(value=>!value||typeof value!=='object'))throw new TypeError('Metadata lifecycle components are required');if(this.#components.some(value=>ownedComponents.has(value)))throw new Error('Metadata component already has a lifecycle owner');for(const value of this.#components)ownedComponents.add(value);this.#options={...options};}
 get status(){return {closed:this.#closed,pending:this.#pending.size,maxPending:this.#maxPending};}
 metadata(filename:string){return this.#options.cache.metadata(filename);}
 #admit<T>(prepare:()=>()=>Promise<T>):Promise<T>{
  if(this.#closed)return Promise.reject(new ApiError(503,'Metadata lifecycle is closed'));if(this.#pending.size>=this.#maxPending)return Promise.reject(new ApiError(503,'Metadata lifecycle queue is full'));
  let operation:()=>Promise<T>;try{operation=prepare();}catch(error){return Promise.reject(error);}
  const task=this.#tail.then(operation);this.#tail=task.catch(()=>{});this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 /** Source ownership is unconditional, even when admission fails. A newly
  * admitted scan revokes old cache tickets before waiting for its durable turn. */
 async scan(filename:string,source:FileHandle,signal:AbortSignal,validateSource:Validate):Promise<MetadataLifecycleScan>{
  let primary:unknown,failed=false;
  try{return await this.#admit(()=>{
   signal.throwIfAborted();validateMetadataFilename(filename);if(typeof validateSource!=='function')throw new TypeError('Metadata source validation is required');
   const o=this.#options,ticket=o.cache.begin(filename);
   return async()=>{
    let intent:MetadataScanIntent|undefined,operationFailure:unknown,operationFailed=false;
    try{
     signal.throwIfAborted();if(o.intents.status.faulted||o.snapshots.status.faulted||o.versions.status.faulted)throw new ApiError(503,'Metadata stores require recovery');if(!o.cache.isCurrent(ticket))throw new ApiError(409,'Metadata scan was superseded');
     intent=await o.intents.begin(filename,signal);const pending=await o.versions.begin(intent,signal);
     const staged=new FileMetadataStore({maxRecords:1,maxBytes:2*1024**2,maxRecordBytes:1024**2});
     const result=await scanFileMetadata({extractor:o.extractor,processor:o.processor,storage:o.images,cache:staged,ticket:staged.begin(filename),source,signal,bundleId:intent.bundleId,validateSource:async(value,s)=>o.cache.isCurrent(ticket)&&await validateSource(value,s)});
     if(!result.committed||!result.extraction)throw new ApiError(409,'Metadata preparation did not complete');
     const stale:MetadataLifecycleScan={committed:false,intent,snapshotId:null,version:null};
     if(!o.cache.isCurrent(ticket))return stale;
     const snapshot=await o.snapshots.put(intent,result.extraction.source,staged.peek(filename)!,signal);stale.snapshotId=snapshot.id;
     signal.throwIfAborted();if(!o.cache.isCurrent(ticket))return stale;
     if(!await validateSource(result.extraction.source,signal))throw new ApiError(409,'Metadata source changed before selection');signal.throwIfAborted();
     const selected=await o.versions.select(pending,signal);if(!selected)return stale;
     // Selection fsync yielded to external source changes. A negative validation
     // durably invalidates our selection before the error becomes observable.
     if(!await validateSource(result.extraction.source,signal)){await o.versions.invalidate(filename,new AbortController().signal);throw new ApiError(409,'Metadata source changed during selection');}
     signal.throwIfAborted();return {committed:o.cache.commit(ticket,snapshot.fields),intent,snapshotId:snapshot.id,version:selected};
    }catch(error){o.cache.fail(ticket);operationFailed=true;operationFailure=intent?new MetadataIntentScanError(intent,error):error;throw operationFailure;}
    finally{if(source.fd>=0){try{await source.close();}catch(cleanup){throw new AggregateError(operationFailed?[operationFailure,cleanup]:[cleanup],'Accepted metadata source cleanup failed');}}}
   };
  });}catch(error){primary=error;failed=true;throw error;}
  finally{if(source.fd>=0){try{await source.close();}catch(cleanup){throw new AggregateError(failed?[primary,cleanup]:[cleanup],'Metadata lifecycle source cleanup failed');}}}
 }
 invalidate(filename:string,signal:AbortSignal):Promise<MetadataVersion>{return this.#admit(()=>{signal.throwIfAborted();validateMetadataFilename(filename);this.#options.cache.invalidate(filename);return ()=>this.#options.versions.invalidate(filename,signal);});}
 recover(filename:string,signal:AbortSignal,validateSource:Validate):Promise<boolean>{return this.#admit(()=>{signal.throwIfAborted();validateMetadataFilename(filename);const o=this.#options;return ()=>restoreCurrentMetadata({versions:o.versions,snapshots:o.snapshots,images:o.images,cache:o.cache,ticket:o.cache.begin(filename),signal,validateSource});});}
 retire(intent:MetadataScanIntent,signal:AbortSignal):Promise<void>{return this.#admit(()=>()=>retireMetadataScan({intent,...this.#options,signal,authorizeRetirement:async value=>this.#options.versions.canRetire(value)}));}
 /** Reclaim only intents explicitly superseded/invalidated in the version store.
  * Unknown intents and the current pending/selected scan are retained. */
 retireSuperseded(signal:AbortSignal):Promise<number>{return this.#admit(()=>async()=>{signal.throwIfAborted();let retired=0;for(const intent of this.#options.intents.unresolved()){signal.throwIfAborted();if(!this.#options.versions.canRetire(intent))continue;await retireMetadataScan({intent,...this.#options,signal,authorizeRetirement:async value=>this.#options.versions.canRetire(value)});retired++;}return retired;});}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#closing=Promise.allSettled([...this.#pending]).then(()=>{for(const value of this.#components)ownedComponents.delete(value);});return this.#closing;}
}
