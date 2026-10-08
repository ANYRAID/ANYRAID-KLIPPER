import {createHash} from 'node:crypto';
import type {FileHandle} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {crc32} from 'node:zlib';
import {RandomAccessReader,fromRandomAccessReaderPromise,type Entry,type ZipFile} from 'yauzl';
import {ApiError} from './rpc.ts';

export interface UfpArchiveLimits {
 maxArchiveBytes?:number;
 maxModelBytes?:number;
 maxThumbnailBytes?:number;
 maxEntries?:number;
 maxDirectoryBytes?:number;
}
export interface ExtractedUfp {
 readonly model:{readonly size:number;readonly sha256:string};
 readonly thumbnail?:{readonly bytes:Buffer;readonly sha256:string};
}
class UfpIoError extends Error {}
/** Positional reads never take ownership of the caller's descriptor. Cleanup
 * drains in-flight I/O before the upload owner may dispose its private staging. */
class BorrowedReader extends RandomAccessReader {
 readonly #source:FileHandle;
 readonly #signal:AbortSignal;
 readonly #streams=new Set<Readable>();
 readonly #reads=new Set<Promise<unknown>>();
 #stopped=false;
 constructor(source:FileHandle,signal:AbortSignal){super();this.#source=source;this.#signal=signal;this.on('error',()=>{});}
 override _readStreamForRange(start:number,end:number):Readable {
  const self=this;
  const stream=Readable.from((async function*(){
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start)throw new ApiError(422,'Invalid UFP byte range');
   for(let position=start;position<end;){
    self.#signal.throwIfAborted();if(self.#stopped)throw new ApiError(499,'UFP reader is closed');
    const buffer=Buffer.allocUnsafe(Math.min(64*1024,end-position));
    const pending=self.#source.read(buffer,0,buffer.length,position);self.#reads.add(pending);
    let bytesRead:number;try{({bytesRead}=await pending);}catch(error){throw new UfpIoError('UFP read failed',{cause:error});}finally{self.#reads.delete(pending);}
    self.#signal.throwIfAborted();if(self.#stopped)throw new ApiError(499,'UFP reader is closed');
    if(!bytesRead)throw new ApiError(422,'Truncated UFP archive');position+=bytesRead;yield buffer.subarray(0,bytesRead);
   }
  })(),{objectMode:false});
  this.#streams.add(stream);stream.on('error',()=>{});stream.once('close',()=>this.#streams.delete(stream));return stream;
 }
 stop(error:Error):void {this.#stopped=true;for(const stream of this.#streams)stream.destroy(error);}
 async drain():Promise<void>{while(this.#reads.size)await Promise.allSettled([...this.#reads]);}
 // yauzl reference release is separate from the caller's FileHandle lifetime.
 override close(callback:(err:Error|null)=>void):void{void this.drain().then(()=>callback(null),error=>callback(error));}
}
function limit(value:number|undefined,fallback:number):number {
 const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>Number.MAX_SAFE_INTEGER/2)throw new RangeError('Invalid UFP capacity');return n;
}
function selected(entry:Entry,maximum:number):void {
 const mode=(entry.externalFileAttributes>>>16)&0xf000;
 if(entry.isEncrypted()||![0,8].includes(entry.compressionMethod)||mode!==0&&mode!==0x8000)throw new ApiError(422,'Unsupported UFP member');
 if(!Number.isSafeInteger(entry.uncompressedSize)||entry.uncompressedSize<0||entry.uncompressedSize>maximum)throw new ApiError(413,'UFP member exceeds capacity');
}
/** Extract only fixed upstream members. Raw ZIP names never become filesystem
 * paths. Model bytes remain exact; the caller must publish model and preview
 * together under its durable owner, or dispose both staging objects on error. */
export async function extractUfpArchive(source:FileHandle,modelTarget:FileHandle,signal:AbortSignal,options:UfpArchiveLimits={}):Promise<ExtractedUfp> {
 const maxArchive=limit(options.maxArchiveBytes,64*1024**2),maxModel=limit(options.maxModelBytes,64*1024**2),maxThumbnail=limit(options.maxThumbnailBytes,4*1024**2),maxEntries=limit(options.maxEntries,1024),maxDirectory=limit(options.maxDirectoryBytes,1024**2);
 signal.throwIfAborted();const before=await source.stat({bigint:true}),target=await modelTarget.stat({bigint:true});
 if(!before.isFile()||!target.isFile()||target.size!==0n||before.dev===target.dev&&before.ino===target.ino)throw new ApiError(409,'UFP requires separate private empty model staging');
 if(before.size>BigInt(maxArchive))throw new ApiError(413,'UFP archive exceeds capacity');
 const reader=new BorrowedReader(source,signal);let zip:ZipFile|undefined,active:Readable|undefined;
 const abort=()=>{const error=signal.reason instanceof Error?signal.reason:new ApiError(499,'UFP extraction cancelled');active?.destroy(error);reader.stop(error);};
 signal.addEventListener('abort',abort,{once:true});
 try{
  zip=await fromRandomAccessReaderPromise(reader,Number(before.size),{autoClose:false,lazyEntries:true,decodeStrings:false,validateEntrySizes:true});zip.on('error',()=>{});
  if(zip.entryCount>maxEntries)throw new ApiError(413,'UFP directory exceeds capacity');
  let model:Entry|undefined,thumbnail:Entry|undefined,count=0,directoryBytes=0;
  for await(const entry of zip.eachEntry()){
   signal.throwIfAborted();directoryBytes+=46+entry.fileNameLength+entry.extraFieldLength+entry.fileCommentLength;
   if(++count>maxEntries||directoryBytes>maxDirectory)throw new ApiError(413,'UFP directory exceeds capacity');
   // decodeStrings=false deliberately permits the upstream leading '/'. Unicode
   // path extras and unsafe unrelated names never influence member selection.
   const name=entry.fileNameRaw;
   if(name.equals(Buffer.from('/3D/model.gcode'))||name.equals(Buffer.from('3D/model.gcode'))){if(model)throw new ApiError(422,'Duplicate UFP model');selected(entry,maxModel);model=entry;}
   else if(name.equals(Buffer.from('/Metadata/thumbnail.png'))||name.equals(Buffer.from('Metadata/thumbnail.png'))){if(thumbnail)throw new ApiError(422,'Duplicate UFP thumbnail');selected(entry,maxThumbnail);thumbnail=entry;}
   if(count%128===0)await new Promise<void>(resolve=>setImmediate(resolve));
  }
  if(!model)throw new ApiError(422,'UFP model is missing');
  const consume=async(entry:Entry,destination?:FileHandle):Promise<{size:number;sha256:string;bytes?:Buffer}>=>{
   signal.throwIfAborted();const stream=await zip!.openReadStreamPromise(entry);active=stream;stream.on('error',()=>{});
   const hash=createHash('sha256'),chunks:Buffer[]=[];let checksum=0,size=0;
   try{for await(const chunk of stream){
    signal.throwIfAborted();const bytes=chunk as Buffer;
    if(size+bytes.length>entry.uncompressedSize)throw new ApiError(422,'UFP member length mismatch');
    checksum=crc32(bytes,checksum);hash.update(bytes);
    if(destination){for(let written=0;written<bytes.length;){signal.throwIfAborted();let n:number;try{({bytesWritten:n}=await destination.write(bytes,written,bytes.length-written,size+written));}catch(error){throw new UfpIoError('UFP write failed',{cause:error});}if(!n)throw new UfpIoError('UFP write made no progress');written+=n;}}
    else chunks.push(bytes);size+=bytes.length;
   }}finally{stream.destroy();active=undefined;}
   if(size!==entry.uncompressedSize||checksum!==entry.crc32)throw new ApiError(422,'UFP member checksum or length mismatch');
   return {size,sha256:hash.digest('hex'),...destination?{}:{bytes:Buffer.concat(chunks,size)}};
  };
  const result=await consume(model,modelTarget),image=thumbnail?await consume(thumbnail):undefined;
  signal.throwIfAborted();const after=await source.stat({bigint:true});
  if((['dev','ino','size','mtimeNs','ctimeNs'] as const).some(key=>before[key]!==after[key]))throw new ApiError(409,'UFP source changed during extraction');
  if(image&&!image.bytes!.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new ApiError(422,'Invalid UFP thumbnail signature');
  return {model:{size:result.size,sha256:result.sha256},...image?{thumbnail:{bytes:image.bytes!,sha256:image.sha256}}:{}};
 }catch(error){if(signal.aborted)throw signal.reason;if(error instanceof ApiError)throw error;if(error instanceof UfpIoError)throw new ApiError(500,'UFP storage I/O failed');throw new ApiError(422,'Invalid UFP archive');}
 finally{signal.removeEventListener('abort',abort);active?.destroy();zip?.close();reader.stop(new ApiError(499,'UFP reader is closed'));await reader.drain();}
}
