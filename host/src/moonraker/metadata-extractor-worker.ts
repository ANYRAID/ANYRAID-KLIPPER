import {parentPort,workerData} from 'node:worker_threads';
import type {FileHandle} from 'node:fs/promises';
import {readMetadataWindow} from './metadata-window.ts';
import {inspectSlicerFields} from './metadata-fields.ts';
import {boundedJsonBytes} from './json-size.ts';
import {ApiError,validateJson} from './rpc.ts';
interface Request {id:number;source:FileHandle;cancel:SharedArrayBuffer;includeThumbnailData?:boolean;}
const port=parentPort!;let queue=Promise.resolve();
async function execute(request:Request):Promise<void>{
 const cancellation=new Int32Array(request.cancel),signal={throwIfAborted(){if(Atomics.load(cancellation,0))throw new ApiError(499,'Metadata extraction cancelled');}};
 let value:unknown,error:unknown;
 try{
  signal.throwIfAborted();const window=await readMetadataWindow(request.source,signal,{maxFileBytes:workerData.maxFileBytes});signal.throwIfAborted();
  const {fields,objects,identity}=inspectSlicerFields(window);signal.throwIfAborted();validateJson(fields);boundedJsonBytes(fields,workerData.maxOutputBytes);
  const after=await request.source.stat({bigint:true});signal.throwIfAborted();
  if(after.dev!==window.source.dev||after.ino!==window.source.ino||after.size!==BigInt(window.size)||after.mtimeNs!==window.source.mtimeNs||after.ctimeNs!==window.source.ctimeNs)throw new ApiError(409,'Metadata source changed during extraction');
  value={fields,source:window.source,objects,...request.includeThumbnailData?{thumbnailData:!['Slic3rPE','Slic3r'].includes(identity.family)&&/thumbnail(?:_[A-Za-z0-9]+)? begin/u.test(window.data)?window.data:''}:{}};
 }catch(reason){error=reason;}
 try{await request.source.close();}catch(reason){throw new AggregateError([error,reason].filter(v=>v!==undefined),'Metadata source close failed');}
 port.postMessage(error?{id:request.id,error:{code:error instanceof ApiError?error.status:422,message:error instanceof Error?error.message:String(error)}}:{id:request.id,value});
}
port.on('message',(request:Request)=>{queue=queue.then(()=>execute(request)).catch(error=>{throw error;});});
port.postMessage({ready:true});
