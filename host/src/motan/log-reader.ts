// GPL-3.0-or-later. Streaming reader for Motan ETX/gzip logs and full-flush indexes.
import {open,constants,type FileHandle} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {createGunzip,createInflateRaw,constants as zlibConstants,type Gunzip,type InflateRaw} from 'node:zlib';
import {pipeline} from 'node:stream/promises';
import {ConsoleFrames} from '../diagnostics/webhook-console.ts';
import {parseMotanJson} from './capture.ts';
import {parseTypedMotanJson} from './number-types.ts';
export interface MotanReadOptions {preserveNumberTypes?:boolean;maxFileBytes?:number;maxDecodedBytes?:number;maxRecordBytes?:number;allowIncomplete?:boolean;signal?:AbortSignal;}
export type MotanMessage=Record<string,unknown>;
/** A fixed initial file extent, with bounded streaming decompression. Offset 0
 * selects gzip; positive positions must be writer-provided full-flush offsets. */
export class MotanLogReader {
 readonly #preserveNumberTypes:boolean;
 readonly #sizes=new WeakMap<MotanMessage,number>();
 readonly #file:FileHandle;readonly #size:number;readonly #maxDecoded:number;readonly #recordLimit:number;readonly #partial:boolean;readonly #signal:AbortSignal|undefined;
 #seeking=false;#position=0;#decoded=0;#generation=0;#closed=false;#eof=false;#failure:unknown;
 #reading:Promise<unknown>|undefined;#source:Readable|undefined;#inflate:Gunzip|InflateRaw|undefined;#pump:Promise<void>|undefined;#iterator:AsyncIterator<Buffer>|undefined;
 #frames:ConsoleFrames;#queue:Buffer[]=[];#at=0;#pending:Promise<MotanMessage[]>|undefined;#closing:Promise<void>|undefined;#messages=0;#ignoredTail=0;
 readonly #abort=()=>{void this.close().catch(()=>{});};
 private constructor(file:FileHandle,size:number,options:MotanReadOptions){this.#preserveNumberTypes=options.preserveNumberTypes??false;this.#file=file;this.#size=size;this.#maxDecoded=options.maxDecodedBytes??4*1024**3;this.#recordLimit=options.maxRecordBytes??1024**2;this.#partial=options.allowIncomplete??false;this.#signal=options.signal;this.#frames=new ConsoleFrames(3,this.#recordLimit,true);this.#signal?.addEventListener('abort',this.#abort,{once:true});}
 static async open(path:string,options:MotanReadOptions={}):Promise<MotanLogReader>{
  options={...options};
  const fileMax=options.maxFileBytes??512*1024**2,decoded=options.maxDecodedBytes??4*1024**3,record=options.maxRecordBytes??1024**2;
  if(!Number.isSafeInteger(fileMax)||fileMax<0||fileMax>1024**4||!Number.isSafeInteger(decoded)||decoded<1||decoded>1024**4||!Number.isSafeInteger(record)||record<1||record>64*1024**2||options.preserveNumberTypes!==undefined&&typeof options.preserveNumberTypes!=='boolean'||options.allowIncomplete!==undefined&&typeof options.allowIncomplete!=='boolean')throw new Error('Invalid Motan reader limits');options.signal?.throwIfAborted();
  const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size>fileMax)throw new Error('Motan input must be a bounded regular file');options.signal?.throwIfAborted();return new MotanLogReader(file,stat.size,options);}catch(error){await file.close();throw error;}
 }
 /** Original encoded record size; conservative queue accounting avoids reserialization. */
 encodedSize(message:MotanMessage):number|undefined{return this.#sizes.get(message);}
 get status(){return {closed:this.#closed,eof:this.#eof,fileSize:this.#size,startOffset:this.#position,decodedBytes:this.#decoded,messages:this.#messages,ignoredTailBytes:this.#ignoredTail,failed:this.#failure!==undefined};}
 #check():void{this.#signal?.throwIfAborted();if(this.#closed)throw new Error('Motan reader is closed');if(this.#failure!==undefined)throw this.#failure;}
 #start():void{
  if(this.#iterator||this.#eof)return;if(this.#position===this.#size){this.#eof=true;return;}
  const generation=this.#generation,settings={chunkSize:65536,finishFlush:this.#partial?zlibConstants.Z_SYNC_FLUSH:zlibConstants.Z_FINISH};
  const reader=this;async function* chunks(){let position=reader.#position;while(position<reader.#size&&generation===reader.#generation&&!reader.#closed&&reader.#failure===undefined){const buffer=Buffer.allocUnsafe(Math.min(65536,reader.#size-position)),work=reader.#file.read(buffer,0,buffer.length,position);reader.#reading=work;let bytesRead:number;try{({bytesRead}=await work);}finally{if(reader.#reading===work)reader.#reading=undefined;}if(generation!==reader.#generation||reader.#closed||reader.#failure!==undefined)return;if(!bytesRead)throw new Error('Motan file truncated during read');position+=bytesRead;yield buffer.subarray(0,bytesRead);}}
  this.#source=Readable.from(chunks(),{objectMode:false,highWaterMark:65536});this.#inflate=this.#position===0?createGunzip(settings):createInflateRaw(settings);
  this.#pump=pipeline(this.#source,this.#inflate);void this.#pump.catch(error=>{if(generation===this.#generation)this.#failure??=error;});this.#iterator=this.#inflate[Symbol.asyncIterator]();
 }
 /** Consume only an already buffered frame; undefined requests asynchronous I/O. */
 pullReadyMessage():MotanMessage|null|undefined{
  this.#check();if(this.#pending||this.#seeking)throw new Error('Concurrent Motan reads are not supported');
  try{if(this.#at<this.#queue.length)return this.#decode(this.#queue[this.#at++]);return this.#eof?null:undefined;}
  catch(error){this.#failure??=error;this.#source?.destroy();this.#inflate?.destroy();throw error;}
 }
 // Raw Stallguard and stepq fields retain their token kinds. Keep this reader-only:
 // capture stores the original bytes and needs metadata only for status.
 #decode(raw:Buffer):MotanMessage{let value=parseMotanJson(raw,this.#preserveNumberTypes);if(this.#preserveNumberTypes&&value&&typeof value==='object'&&typeof (value as MotanMessage).q==='string'&&/^(?:stallguard|stepq):/.test((value as MotanMessage).q as string))value=parseTypedMotanJson(raw.toString('utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Motan message must be a JSON object');this.#sizes.set(value as MotanMessage,raw.length);this.#messages++;return value as MotanMessage;}
 pullMessage():Promise<MotanMessage|null>{return this.pullMessages(1).then(values=>values[0]??null);}
 pullMessages(limit=256):Promise<MotanMessage[]>{
  try{this.#check();if(this.#pending||this.#seeking)throw new Error('Concurrent Motan reads are not supported');if(!Number.isSafeInteger(limit)||limit<1||limit>1024)throw new Error('Invalid Motan read batch size');}catch(error){return Promise.reject(error);}
  const work=this.#read(limit),done=work.finally(()=>{this.#pending=undefined;});this.#pending=done;return done;
 }
 async #read(limit:number):Promise<MotanMessage[]>{
  try{this.#start();const result:MotanMessage[]=[];let bytes=0;
   while(result.length<limit){this.#check();if(this.#at<this.#queue.length){const raw=this.#queue[this.#at];if(result.length&&bytes+raw.length>4*1024**2)break;this.#at++;bytes+=raw.length;result.push(this.#decode(raw));continue;}
    this.#queue=[];this.#at=0;if(this.#eof)break;const next=await this.#iterator!.next();this.#check();
    if(next.done){await this.#pump;this.#eof=true;if(this.#frames.pending){if(!this.#partial)throw new Error('Motan log ends with an incomplete record');this.#ignoredTail=this.#frames.pending;this.#frames=new ConsoleFrames(3,this.#recordLimit,true);}break;}
    this.#decoded+=next.value.length;if(this.#decoded>this.#maxDecoded)throw new Error('Motan decompression limit exceeded');this.#queue=this.#frames.push(next.value);
   }return result;
  }catch(error){const cause=this.#signal?.aborted?this.#signal.reason:this.#closed?new Error('Motan reader is closed'):error;if(!this.#closed)this.#failure??=cause;this.#source?.destroy();this.#inflate?.destroy();throw cause;}
 }
 async seek(position:number):Promise<void>{
  this.#check();if(this.#pending||this.#seeking)throw new Error('Cannot seek during a Motan read');if(!Number.isSafeInteger(position)||position<0||position>this.#size)throw new Error('Invalid Motan index offset');
  this.#seeking=true;try{this.#generation++;this.#source?.destroy();this.#inflate?.destroy();await Promise.allSettled([this.#pump,this.#reading]);this.#check();this.#source=undefined;this.#inflate=undefined;this.#pump=undefined;this.#iterator=undefined;this.#position=position;this.#decoded=0;this.#eof=false;this.#queue=[];this.#at=0;this.#frames=new ConsoleFrames(3,this.#recordLimit,true);this.#ignoredTail=0;}finally{this.#seeking=false;}
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;this.#generation++;this.#signal?.removeEventListener('abort',this.#abort);this.#source?.destroy();this.#inflate?.destroy();
  this.#closing=(async()=>{await Promise.allSettled([this.#pending,this.#pump,this.#reading]);this.#queue=[];this.#frames=new ConsoleFrames(3,this.#recordLimit,true);this.#source=undefined;this.#inflate=undefined;this.#iterator=undefined;this.#pump=undefined;this.#reading=undefined;await this.#file.close();})();return this.#closing;
 }
}
