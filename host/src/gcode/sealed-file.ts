import {createRequire} from 'node:module';
import {open,type FileHandle} from 'node:fs/promises';
import {closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {GCodeFileReader} from './file-reader.ts';
import {defaultPrintSnapshotBudget,type PrintSnapshotBudget} from './snapshot-budget.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {create():number;seal(fd:number):void};
/** Copy an authorized source into a Linux kernel-sealed snapshot. Source ownership
 * stays with the caller. Expected SHA-256 comes from trusted published metadata. */
async function createSealed<T>(source:FileHandle,expectedSHA256:string,signal:AbortSignal,options:{maxBytes?:number;budget?:PrintSnapshotBudget},adopt:(file:FileHandle,release:()=>void)=>Promise<T>){
 const max=options.maxBytes??64*1024**2;
 if(typeof expectedSHA256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSHA256)||!Number.isSafeInteger(max)||max<1||max>1024**3)throw new RangeError('Invalid sealed print snapshot limits or digest');
 signal.throwIfAborted();const before=await source.stat({bigint:true});signal.throwIfAborted();
 if(!before.isFile()||before.size>BigInt(max))throw new Error('Print source exceeds bounded regular file requirement');
 const lease=(options.budget??defaultPrintSnapshotBudget).reserve(Number(before.size));
 let snapshot:FileHandle|undefined,rawOpen=false;
 try{
  const fd=native.create();rawOpen=true;
  try{snapshot=await open(`/proc/self/fd/${fd}`,'r+');}finally{closeSync(fd);rawOpen=false;}
  const buffer=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
  while(position<Number(before.size)){
   signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,Number(before.size)-position),position);signal.throwIfAborted();
   if(!bytesRead)throw new Error('Print source truncated while snapshotting');
   hash.update(buffer.subarray(0,bytesRead));let written=0;
   while(written<bytesRead){signal.throwIfAborted();const result=await snapshot.write(buffer,written,bytesRead-written,position+written);if(!result.bytesWritten)throw new Error('Print snapshot write stalled');written+=result.bytesWritten;}
   position+=bytesRead;
  }
  signal.throwIfAborted();const after=await source.stat({bigint:true});signal.throwIfAborted();
  if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Print source changed while snapshotting');
  const sha256=hash.digest('hex');if(sha256!==expectedSHA256)throw new Error('Print source digest does not match published file');
  native.seal(snapshot.fd);signal.throwIfAborted();
  const reader=await adopt(snapshot,lease.release);signal.throwIfAborted();
  return Object.freeze({reader,sha256,size:position});
 }catch(error){try{await snapshot?.close();}catch(closeError){throw new AggregateError([error,closeError],'Print snapshot cleanup failed; quota retained',{cause:error});}
  if(!rawOpen)lease.release();throw error;
 }
}

export function createSealedPrintReader(source:FileHandle,expectedSHA256:string,signal:AbortSignal,options:{maxBytes?:number;batchLines?:number;budget?:PrintSnapshotBudget}={}){
 const batchLines=options.batchLines??128;if(!Number.isSafeInteger(batchLines)||batchLines<1||batchLines>128)return Promise.reject(new RangeError('Invalid sealed print batch limit'));
 return createSealed(source,expectedSHA256,signal,options,(file,release)=>GCodeFileReader.adopt(file,{maxBytes:options.maxBytes??64*1024**2,batchLines,onClosed:release}));
}
/** Binary snapshots preserve every source byte; no text decoding or line limits. */
export class SealedBinaryReader {
 #file:FileHandle;#size:number;#release:()=>void;#reading=false;#closed=false;#closing:Promise<void>|undefined;
 constructor(file:FileHandle,size:number,release:()=>void){this.#file=file;this.#size=size;this.#release=release;}
 async *chunks(signal:AbortSignal,start=0,end=this.#size):AsyncGenerator<Buffer>{
  if(this.#closed||this.#reading)throw new Error('Binary snapshot is unavailable');
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>this.#size)throw new RangeError('Invalid binary snapshot range');
  this.#reading=true;
  try{for(let offset=start;offset<end;){signal.throwIfAborted();if(this.#closed)throw new Error('Binary snapshot is closed');const buffer=Buffer.allocUnsafe(Math.min(65536,end-offset));const {bytesRead}=await this.#file.read(buffer,0,buffer.length,offset);signal.throwIfAborted();if(!bytesRead)throw new Error('Binary snapshot truncated');offset+=bytesRead;yield buffer.subarray(0,bytesRead);}}
  finally{this.#reading=false;}
 }
 close():Promise<void>{this.#closed=true;return this.#closing??=this.#file.close().then(this.#release);}
}
export function createSealedBinaryReader(source:FileHandle,expectedSHA256:string,signal:AbortSignal,options:{maxBytes?:number;budget?:PrintSnapshotBudget}={}){
 return createSealed(source,expectedSHA256,signal,options,async(file,release)=>new SealedBinaryReader(file,Number((await file.stat()).size),release));
}
