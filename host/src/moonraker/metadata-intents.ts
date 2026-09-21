import {randomUUID} from 'node:crypto';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {sealedBuffer} from '../storage/sealed-buffer.ts';
import {PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
export interface MetadataScanIntent {readonly version:1;readonly id:string;readonly filename:string;readonly bundleId:string;}
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}',idPattern=new RegExp('^scan-('+uuid+')$');
function validFilename(value:unknown):value is string{return typeof value==='string'&&value.isWellFormed()&&!!value&&Buffer.byteLength(value)<=4096&&!value.includes('\0')&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..');}
function decode(bytes:Buffer,id:string):MetadataScanIntent{
 const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),match=idPattern.exec(id);
 if(!match||!value||Object.keys(value).length!==4||value.version!==1||value.id!==id||value.bundleId!=='thumb-'+match[1]||!validFilename(value.filename))throw new Error('Invalid persisted metadata scan intent');
 return Object.freeze({version:1,id,filename:value.filename,bundleId:value.bundleId});
}
/** A write error can have an uncertain durable result. The original intent stays
 * available to the caller; reopening verifies receipts before reconciliation. */
export class MetadataIntentWriteError extends Error {
 readonly intent:MetadataScanIntent;
 constructor(intent:MetadataScanIntent,cause:unknown){super('Metadata intent write requires recovery',{cause});this.intent=intent;}
}
/** Dedicated private store of unresolved scans. No timestamps/order heuristics,
 * metadata replay or image deletion. Acknowledge only after owner reconciliation. */
export class MetadataScanIntents {
 #store:PublishedPrintFiles;#records=new Map<string,MetadataScanIntent>();#maxRecords:number;#maxPending:number;
 #tail:Promise<unknown>=Promise.resolve();#pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;#fault:unknown;
 #budget=new PrintSnapshotBudget({maxBytes:65536,maxSnapshots:1});
 private constructor(store:PublishedPrintFiles,maxRecords:number,maxPending:number){this.#store=store;this.#maxRecords=maxRecords;this.#maxPending=maxPending;}
 static async open(directory:string,options:{maxIntents?:number;maxPending?:number}={}):Promise<MetadataScanIntents>{
  const count=options.maxIntents??1024,pending=options.maxPending??4;
  if(!Number.isSafeInteger(count)||count<1||count>4096||!Number.isSafeInteger(pending)||pending<1||pending>16)throw new RangeError('Invalid metadata intent capacity');
  const store=await PublishedPrintFiles.open(directory,{maxFileBytes:32768,maxPublishedFiles:count,maxStorageBytes:256*1024**2,maxOperations:1}),instance=new MetadataScanIntents(store,count,pending);
  try{const signal=new AbortController().signal,ids=await store.listIds(signal);if(ids.length>4096)throw new Error('Metadata intent recovery capacity exceeded');for(const id of ids){const {record,bytes}=await store.readBytes(id,signal,32768);if(record.name!=='metadata-scan-intent')throw new Error('Unexpected metadata intent receipt');instance.#records.set(id,decode(bytes,id));}return instance;}catch(error){await store.close();throw error;}
 }
 get status(){return {closed:this.#closed,faulted:this.#fault!==undefined,pending:this.#pending.size,intents:this.#records.size,maxIntents:this.#maxRecords,staging:this.#budget.status};}
 /** Independent immutable array of known durable records. On fault, reopen first. */
 unresolved():readonly MetadataScanIntent[]{if(this.#closed||this.#fault!==undefined)throw new Error('Metadata intents require an open recovered store');return Object.freeze([...this.#records.values()]);}
 #run<T>(operation:()=>Promise<T>):Promise<T>{
  if(this.#closed)return Promise.reject(new Error('Metadata intents are closed'));if(this.#pending.size>=this.#maxPending)return Promise.reject(new Error('Metadata intent queue is full'));
  const task=this.#tail.then(()=>{if(this.#fault!==undefined)throw new Error('Metadata intents require recovery',{cause:this.#fault});return operation();});this.#tail=task.catch(()=>{});this.#pending.add(task);return task.finally(()=>this.#pending.delete(task));
 }
 begin(filename:string,signal:AbortSignal):Promise<MetadataScanIntent>{return this.#run(async()=>{
  signal.throwIfAborted();if(!validFilename(filename))throw new TypeError('Invalid metadata intent filename');if(this.#records.size>=this.#maxRecords)throw new Error('Metadata intent capacity exceeded');
  const token=randomUUID(),intent:MetadataScanIntent=Object.freeze({version:1,id:'scan-'+token,filename,bundleId:'thumb-'+token});let stage:Awaited<ReturnType<typeof sealedBuffer>>|undefined;
  try{stage=await sealedBuffer(Buffer.from(JSON.stringify(intent)),signal,this.#budget);await this.#store.publish(intent.id,'metadata-scan-intent',stage.file,signal);await stage.close();stage=undefined;this.#records.set(intent.id,intent);return intent;}
  catch(error){try{await stage?.close();}catch(cleanup){error=new AggregateError([error,cleanup],'Metadata intent staging cleanup failed');}this.#fault=error;throw new MetadataIntentWriteError(intent,error);}
 });}
 acknowledge(intent:MetadataScanIntent,signal:AbortSignal):Promise<void>{return this.#run(async()=>{
  signal.throwIfAborted();if(!intent||this.#records.get(intent.id)!==intent)throw new Error('Unknown or stale metadata intent');
  try{await this.#store.remove(intent.id,signal);this.#records.delete(intent.id);}catch(error){this.#fault=error;throw new MetadataIntentWriteError(intent,error);}
 });}
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#store.close());return this.#closing;}
}
