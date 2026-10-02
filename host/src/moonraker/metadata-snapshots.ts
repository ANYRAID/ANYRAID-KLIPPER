import {PublishedPrintFiles} from '../storage/published-files.ts';
import {sealedBuffer} from '../storage/sealed-buffer.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {FileMetadataStore,type MetadataTicket} from './file-metadata.ts';
import {metadataScanIntent,type MetadataScanIntent} from './metadata-intents.ts';
import type {MetadataExtraction} from './metadata-extractor.ts';
import type {ThumbnailStorage} from './thumbnail-storage.ts';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
type Source=MetadataExtraction['source'];
type EncodedSource={dev:string;ino:string;mtimeNs:string;ctimeNs:string};
export interface MetadataSnapshot {readonly version:1;readonly id:string;readonly intent:MetadataScanIntent;readonly source:Readonly<EncodedSource>;readonly fields:Readonly<Record<string,Json>>;}
const MAX_BYTES=2*1024**2;
const validId=(id:string)=>{if(typeof id!=='string'||!/^meta-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new TypeError('Invalid metadata snapshot ID');};
function sourceFrom(value:EncodedSource):Source{
 if(!value||Object.keys(value).length!==4)throw new Error('Invalid metadata source fingerprint');const result={} as Source;
 for(const key of ['dev','ino','mtimeNs','ctimeNs'] as const){const item=value[key];if(typeof item!=='string'||!/^-?(?:0|[1-9][0-9]{0,63})$/.test(item)||BigInt(item).toString()!==item)throw new Error('Invalid metadata source integer');result[key]=BigInt(item);}
 if(result.dev<0n||result.ino<0n)throw new Error('Invalid metadata source identity');return Object.freeze(result);
}
function snapshot(value:MetadataSnapshot,id:string):MetadataSnapshot{
 validId(id);if(!value||Object.keys(value).length!==5||value.version!==1||value.id!==id)throw new Error('Invalid metadata snapshot');const intent=metadataScanIntent(value.intent);if(id!=='meta-'+intent.id.slice(5))throw new Error('Metadata snapshot intent mismatch');sourceFrom(value.source);
 validateJson(value.fields);boundedJsonBytes(value.fields,1024**2);
 const cache=new FileMetadataStore({maxRecords:1,maxBytes:2*1024**2,maxRecordBytes:1024**2});cache.commit(cache.begin(intent.filename),value.fields);const fields=cache.peek(intent.filename)!;
 if(!Number.isSafeInteger(fields.size)||typeof fields.size!=='number'||fields.size<0||fields.size>1024**4||typeof fields.modified!=='number'||!Number.isFinite(fields.modified))throw new Error('Invalid metadata source fields');
 const thumbs=fields.thumbnails;if(!Array.isArray(thumbs)||thumbs.length>65)throw new Error('Invalid snapshot thumbnails');
 for(const [index,item] of thumbs.entries()){if(!item||typeof item!=='object'||Array.isArray(item)||Object.keys(item).length!==4||!['png','jpg'].some(ext=>item.relative_path===`.thumbs/${intent.bundleId}/${index}.${ext}`)||!Number.isSafeInteger(item.size)||typeof item.size!=='number'||item.size<1||item.size>8*1024**2||!Number.isSafeInteger(item.width)||typeof item.width!=='number'||item.width<1||item.width>2048||!Number.isSafeInteger(item.height)||typeof item.height!=='number'||item.height<1||item.height>2048)throw new Error('Invalid snapshot thumbnail reference');}
 return Object.freeze({version:1,id,intent,source:Object.freeze({...value.source}),fields});
}
export class MetadataSnapshotWriteError extends Error {
 readonly snapshotId:string;
 constructor(id:string,cause:unknown){super('Metadata snapshot write requires recovery',{cause});this.snapshotId=id;}
}
/** Immutable scan snapshots. IDs identify a specific scan, never a latest version.
 * The owner selects/reconciles candidates; this store cannot infer scan order. */
export class MetadataSnapshots {
 #store:PublishedPrintFiles;#pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;#fault:unknown;
 #budget=new PrintSnapshotBudget({maxBytes:2*(MAX_BYTES+65536),maxSnapshots:2});
 private constructor(store:PublishedPrintFiles){this.#store=store;}
 static async open(directory:string,options:{maxSnapshots?:number;maxStorageBytes?:number}={}):Promise<MetadataSnapshots>{
  const count=options.maxSnapshots??1024;if(!Number.isSafeInteger(count)||count<1||count>4096)throw new RangeError('Invalid metadata snapshot capacity');
  const store=await PublishedPrintFiles.open(directory,{maxFileBytes:MAX_BYTES,maxPublishedFiles:count,maxOperations:2,maxStorageBytes:options.maxStorageBytes??256*1024**2});
  try{for(const id of await store.listIds(new AbortController().signal))validId(id);return new MetadataSnapshots(store);}catch(error){await store.close();throw error;}
 }
 get status(){return {closed:this.#closed,faulted:this.#fault!==undefined,pending:this.#pending.size,staging:this.#budget.status,storage:this.#store.status};}
 #run<T>(operation:()=>Promise<T>):Promise<T>{if(this.#closed||this.#fault!==undefined)return Promise.reject(new Error('Metadata snapshots require an open recovered store'));if(this.#pending.size>=2)return Promise.reject(new Error('Metadata snapshot operation limit exceeded'));const task=Promise.resolve().then(operation);this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));}
 listIds(signal:AbortSignal):Promise<readonly string[]>{const earlier=[...this.#pending];return this.#run(async()=>{await Promise.allSettled(earlier);signal.throwIfAborted();if(this.#fault!==undefined)throw new Error('Metadata snapshots require recovery');return this.#store.listIds(signal);});}
 put(intent:MetadataScanIntent,source:Source,fields:Readonly<Record<string,Json>>,signal:AbortSignal):Promise<MetadataSnapshot>{return this.#run(async()=>{
  signal.throwIfAborted();const record=snapshot({version:1,id:'meta-'+intent.id.slice(5),intent,source:{dev:String(source.dev),ino:String(source.ino),mtimeNs:String(source.mtimeNs),ctimeNs:String(source.ctimeNs)},fields},'meta-'+intent.id.slice(5)),bytes=Buffer.from(JSON.stringify(record));if(bytes.length>MAX_BYTES)throw new RangeError('Metadata snapshot byte limit exceeded');
  let stage:Awaited<ReturnType<typeof sealedBuffer>>|undefined;
  try{stage=await sealedBuffer(bytes,signal,this.#budget);await this.#store.publish(record.id,'metadata-snapshot',stage.file,signal);await stage.close();stage=undefined;return record;}
  catch(error){try{await stage?.close();}catch(cleanup){error=new AggregateError([error,cleanup],'Metadata snapshot staging cleanup failed');}this.#fault=error;throw new MetadataSnapshotWriteError(record.id,error);}
 });}
 read(id:string,signal:AbortSignal):Promise<MetadataSnapshot>{return this.#run(async()=>{validId(id);const {record,bytes}=await this.#store.readBytes(id,signal,MAX_BYTES);if(record.name!=='metadata-snapshot')throw new Error('Unexpected metadata snapshot receipt');return snapshot(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),id);});}
 remove(id:string,signal:AbortSignal):Promise<void>{return this.#run(async()=>{validId(id);signal.throwIfAborted();try{await this.#store.remove(id,signal);}catch(error){this.#fault=error;throw new MetadataSnapshotWriteError(id,error);}});}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#store.close());return this.#closing;}
}
/** Restore one explicitly chosen candidate, never choose the newest by ID/time.
 * Caller must also rule out unresolved competing scans and durable invalidation. */
export async function restoreMetadataSnapshot(snapshots:MetadataSnapshots,id:string,cache:FileMetadataStore,ticket:MetadataTicket,images:ThumbnailStorage,validateSource:(source:Source,signal:AbortSignal)=>Promise<boolean>,signal:AbortSignal):Promise<boolean>{
 try{
  signal.throwIfAborted();if(!cache.isCurrent(ticket))return false;const record=await snapshots.read(id,signal);if(record.intent.filename!==ticket.filename)throw new ApiError(409,'Metadata snapshot filename mismatch');
  const source=sourceFrom(record.source);if(!await validateSource(source,signal))throw new ApiError(409,'Metadata snapshot source changed');signal.throwIfAborted();if(!cache.isCurrent(ticket))return false;
  const thumbs=record.fields.thumbnails as Record<string,Json>[];
  if(thumbs.length){const bundle=await images.inspect(record.intent.bundleId,signal);if(bundle.thumbnails.length!==thumbs.length||bundle.thumbnails.some((item,i)=>item.width!==thumbs[i].width||item.height!==thumbs[i].height||item.size!==thumbs[i].size||item.relative_path!==thumbs[i].relative_path))throw new ApiError(409,'Metadata snapshot thumbnail mismatch');}
  if(!await validateSource(source,signal))throw new ApiError(409,'Metadata snapshot source changed');signal.throwIfAborted();return cache.commit(ticket,record.fields);
 }catch(error){cache.fail(ticket);throw error;}
}
