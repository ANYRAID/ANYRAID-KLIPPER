// GPL-3.0-or-later. Motan ETX/gzip layout from scripts/motan/data_logger.py.
import {open,type FileHandle} from 'node:fs/promises';
import {finished} from 'node:stream/promises';
import {createGzip,constants,type Gzip} from 'node:zlib';
/** Serialized, bounded records. Z_FULL_FLUSH offsets can restart raw inflate.
 * Owns its output file; rejects overwrites rather than truncating old captures. */
export class MotanLogWriter {
 readonly #file:FileHandle;readonly #maxRecord:number;readonly #maxPending:number;readonly #maxBytes:number;
 #gzip:Gzip|undefined;#pump:Promise<void>|undefined;#writes:Promise<void>=Promise.resolve();
 #tail:Promise<unknown>=Promise.resolve();#closing:Promise<void>|undefined;#closed=false;#failure:unknown;
 #pending=0;#pendingBytes=0;#raw=0;#position=0;
 private constructor(file:FileHandle,options:{maxRecordBytes:number;maxPending:number;maxPendingBytes:number}){this.#file=file;this.#maxRecord=options.maxRecordBytes;this.#maxPending=options.maxPending;this.#maxBytes=options.maxPendingBytes;}
 static async open(path:string,options:{maxRecordBytes?:number;maxPending?:number;maxPendingBytes?:number}={}):Promise<MotanLogWriter>{
  const limits={maxRecordBytes:options.maxRecordBytes??1024*1024,maxPending:options.maxPending??32,maxPendingBytes:options.maxPendingBytes??4*1024*1024};
  if(!Number.isSafeInteger(limits.maxRecordBytes)||limits.maxRecordBytes<1||limits.maxRecordBytes>64*1024**2||!Number.isSafeInteger(limits.maxPending)||limits.maxPending<1||limits.maxPending>1024||!Number.isSafeInteger(limits.maxPendingBytes)||limits.maxPendingBytes<1||limits.maxPendingBytes>64*1024**2)throw new RangeError('Invalid Motan writer limits');
  return new MotanLogWriter(await open(path,'wx',0o600),limits);
 }
 get status(){return {closed:this.#closed,pending:this.#pending,pendingBytes:this.#pendingBytes,rawPosition:this.#raw,filePosition:this.#position,failed:this.#failure!==undefined};}
 #enqueue<T>(bytes:number,action:()=>Promise<T>):Promise<T>{
  if(this.#closed)return Promise.reject(new Error('Motan writer is closed'));
  if(this.#failure!==undefined)return Promise.reject(this.#failure);
  if(this.#pending>=this.#maxPending||bytes>this.#maxBytes-this.#pendingBytes)return Promise.reject(new Error('Motan writer capacity exceeded'));
  this.#pending++;this.#pendingBytes+=bytes;
  const work=this.#tail.then(async()=>{if(this.#failure!==undefined)throw this.#failure;try{return await action();}catch(error){this.#failure??=error;throw error;}});
  const done=work.finally(()=>{this.#pending--;this.#pendingBytes-=bytes;});this.#tail=done.then(()=>{},()=>{});return done;
 }
 #start():void{
  if(this.#gzip)return;
  this.#gzip=createGzip({chunkSize:65536});
  this.#gzip.on('error',error=>{this.#failure??=error;});
  // Flowing output is never paused: each input awaits its disk writes before
  // admitting the next batch, bounding output by one batch plus zlib state.
  this.#gzip.on('data',(chunk:Buffer)=>{
   this.#writes=this.#writes.then(async()=>{let at=0;while(at<chunk.length){const {bytesWritten}=await this.#file.write(chunk,at,chunk.length-at,this.#position);if(!bytesWritten)throw new Error('Motan file write stalled');at+=bytesWritten;this.#position+=bytesWritten;if(!Number.isSafeInteger(this.#position))throw new Error('Motan compressed offset exceeds safe integer range');}});
   void this.#writes.catch(error=>{this.#failure??=error;this.#gzip!.destroy(error);});
  });
  this.#pump=finished(this.#gzip);void this.#pump.catch(error=>{this.#failure??=error;});
 }
 addData(data:Uint8Array):Promise<void>{return this.addRecords([data]);}
 /** Batch only records with no index boundary between them. ETX bytes and order
  * are identical to single writes; avoids one zlib work request per tiny frame. */
 addRecords(records:readonly Uint8Array[]):Promise<void>{
  return this.#addRecords(records,false) as Promise<void>;
 }
 /** Publish a restart boundary for this batch in one serialized operation. */
 addRecordsAndFlush(records:readonly Uint8Array[]):Promise<number>{
  return this.#addRecords(records,true) as Promise<number>;
 }
 #addRecords(records:readonly Uint8Array[],flush:boolean):Promise<void|number>{
  if(!Array.isArray(records)||!records.length||records.length>1024)return Promise.reject(new Error('Invalid Motan batch count'));
  let size=0;for(const data of records){if(!(data instanceof Uint8Array)||data.byteLength>this.#maxRecord||data.includes(3))return Promise.reject(new Error('Invalid Motan record size or delimiter'));size+=data.byteLength+1;if(size>this.#maxBytes-this.#pendingBytes)return Promise.reject(new Error('Motan writer capacity exceeded'));}
  if(this.#pending>=this.#maxPending||this.#closed||this.#failure!==undefined)return Promise.reject(this.#failure??new Error('Motan writer closed or capacity exceeded'));
  const record=Buffer.allocUnsafe(size);let at=0;for(const data of records){record.set(data,at);at+=data.byteLength;record[at++]=3;}
  return this.#enqueue(record.length,async()=>{if(!Number.isSafeInteger(this.#raw+record.length))throw new Error('Motan raw offset exceeds safe integer range');this.#start();
   const written=new Promise<void>((resolve,reject)=>this.#gzip!.write(record,error=>error?reject(error):resolve()));
   // Queue FULL_FLUSH immediately after the input. The stream preserves order;
   // both callbacks and all resulting disk writes must finish before publishing.
   if(flush)await Promise.all([written,new Promise<void>((resolve,reject)=>this.#gzip!.flush(constants.Z_FULL_FLUSH,(error?:Error)=>error?reject(error):resolve()))]);
   else await written;
   await this.#writes;if(this.#failure!==undefined)throw this.#failure;this.#raw+=record.length;
   if(flush)return this.#position;
  });
 }
 flush():Promise<number>{return this.#enqueue(0,async()=>{
  if(!this.#gzip)return this.#position;
  await new Promise<void>((resolve,reject)=>this.#gzip!.flush(constants.Z_FULL_FLUSH,(error?:Error)=>error?reject(error):resolve()));
  await this.#writes;
  if(this.#failure!==undefined)throw this.#failure;return this.#position;
 });}
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  this.#closing=(async()=>{await this.#tail;try{if(this.#gzip){if(this.#failure!==undefined)this.#gzip.destroy(this.#failure instanceof Error?this.#failure:new Error('Motan writer failed'));else this.#gzip.end();await this.#pump;await this.#writes;}if(this.#failure!==undefined)throw this.#failure;}finally{await this.#writes.catch(()=>{});await this.#file.close();}})();return this.#closing;
 }
}
