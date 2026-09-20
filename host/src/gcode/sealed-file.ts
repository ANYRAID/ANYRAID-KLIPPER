import {createRequire} from 'node:module';
import {open,type FileHandle} from 'node:fs/promises';
import {closeSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {GCodeFileReader} from './file-reader.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {create():number;seal(fd:number):void};
/** Copy an authorized source into a Linux kernel-sealed snapshot. Source ownership
 * stays with the caller. Expected SHA-256 comes from trusted published metadata. */
export async function createSealedPrintReader(source:FileHandle,expectedSHA256:string,signal:AbortSignal,options:{maxBytes?:number;batchLines?:number}={}){
 const max=options.maxBytes??64*1024**2;
 if(typeof expectedSHA256!=='string'||!/^[a-f0-9]{64}$/.test(expectedSHA256)||!Number.isSafeInteger(max)||max<1||max>1024**3)throw new RangeError('Invalid sealed print snapshot limits or digest');
 const batchLines=options.batchLines??128;if(!Number.isSafeInteger(batchLines)||batchLines<1||batchLines>128)throw new RangeError('Invalid sealed print batch limit');
 signal.throwIfAborted();const before=await source.stat({bigint:true});signal.throwIfAborted();
 if(!before.isFile()||before.size>BigInt(max))throw new Error('Print source exceeds bounded regular file requirement');
 const fd=native.create();let snapshot:FileHandle;
 try{snapshot=await open(`/proc/self/fd/${fd}`,'r+');}finally{closeSync(fd);}
 try{
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
  const reader=await GCodeFileReader.adopt(snapshot,{maxBytes:max,batchLines});signal.throwIfAborted();
  return Object.freeze({reader,sha256,size:position});
 }catch(error){try{await snapshot.close();}catch(closeError){throw new AggregateError([error,closeError],'Print snapshot cleanup failed',{cause:error});}throw error;}
}
