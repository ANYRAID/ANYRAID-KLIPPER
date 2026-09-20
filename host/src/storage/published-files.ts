import {open,mkdir,link,unlink,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createSealedPrintReader} from '../gcode/sealed-file.ts';
import {defaultPrintSnapshotBudget,type PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
export interface PublishedPrintFile {readonly version:1;readonly id:string;readonly sha256:string;readonly size:number;readonly name:string;}
/** Private flat storage. Caller authenticates/authorizes IDs; no client paths.
 * Content and receipts are immutable publications. Root descriptor anchors IO. */
export class PublishedPrintFiles {
 #root:FileHandle;#maxBytes:number;#maxOperations:number;#budget:PrintSnapshotBudget;
 #pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;
 private constructor(root:FileHandle,maxBytes:number,maxOperations:number,budget:PrintSnapshotBudget){this.#root=root;this.#maxBytes=maxBytes;this.#maxOperations=maxOperations;this.#budget=budget;}
 static async open(directory:string,options:{maxFileBytes?:number;maxOperations?:number;budget?:PrintSnapshotBudget}={}):Promise<PublishedPrintFiles>{
  const max=options.maxFileBytes??64*1024**2,count=options.maxOperations??8;
  if(typeof directory!=='string'||!isAbsolute(directory)||!Number.isSafeInteger(max)||max<1||max>1024**3||!Number.isSafeInteger(count)||count<1||count>64)throw new RangeError('Invalid published file store configuration');
  await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const root=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const stat=await root.stat();if(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw new Error('Published file directory must be private and owned by service');return new PublishedPrintFiles(root,max,count,options.budget??defaultPrintSnapshotBudget);}catch(error){await root.close();throw error;}
 }
 get status(){return {closed:this.#closed,pendingOperations:this.#pending.size,maxFileBytes:this.#maxBytes,maxOperations:this.#maxOperations};}
 #id(id:string):void{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('Invalid published file identifier');}
 #path(name:string):string{return `/proc/self/fd/${this.#root.fd}/${name}`;}
 #run<T>(operation:()=>Promise<T>):Promise<T>{
  if(this.#closed)return Promise.reject(new Error('Published file store is closed'));
  if(this.#pending.size>=this.#maxOperations)return Promise.reject(new Error('Published file operation limit exceeded'));
  const job=Promise.resolve().then(operation);this.#pending.add(job);void job.then(()=>this.#pending.delete(job),()=>this.#pending.delete(job));return job;
 }
 async #record(id:string):Promise<PublishedPrintFile>{
  const file=await open(this.#path(id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stat=await file.stat();if(!stat.isFile()||stat.size>2048)throw new Error('Invalid published file receipt');
   const buffer=Buffer.alloc(2049),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>2048)throw new Error('Published receipt exceeds limit');
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead))) as PublishedPrintFile;
   if(value===null||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.id!==id||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<0||value.size>this.#maxBytes||typeof value.name!=='string'||!value.name||value.name.length>256||/[\u0000-\u001f\u007f]/u.test(value.name))throw new Error('Invalid published file receipt');
   return Object.freeze({version:1,id,sha256:value.sha256,size:value.size,name:value.name});
  }finally{await file.close();}
 }
 async #verifyExisting(record:PublishedPrintFile,signal:AbortSignal):Promise<void>{
  const file=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||stat.size!==record.size)throw new Error('Existing published content is invalid');const buffer=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
   while(position<record.size){signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,record.size-position),position);if(!bytesRead)throw new Error('Existing published content is truncated');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
   signal.throwIfAborted();if(hash.digest('hex')!==record.sha256)throw new Error('Existing published content digest mismatch');
  }finally{await file.close();}
 }
 inspect(id:string):Promise<PublishedPrintFile>{return this.#run(async()=>{this.#id(id);return this.#record(id);});}
 publish(id:string,name:string,source:FileHandle,signal:AbortSignal):Promise<PublishedPrintFile>{return this.#run(async()=>{
  this.#id(id);if(typeof name!=='string'||!name||name.length>256||/[\u0000-\u001f\u007f]/u.test(name))throw new Error('Invalid published file name');signal.throwIfAborted();
  const before=await source.stat({bigint:true});signal.throwIfAborted();if(!before.isFile()||before.size>BigInt(this.#maxBytes))throw new Error('Published source exceeds regular file limit');
  const temp=this.#path('.upload-'+randomUUID()),receiptTemp=this.#path('.receipt-'+randomUUID());let file:FileHandle|undefined,receipt:FileHandle|undefined,failure:unknown;
  try{
   file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   const buffer=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
   while(position<Number(before.size)){
    signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,Number(before.size)-position),position);signal.throwIfAborted();if(!bytesRead)throw new Error('Published source truncated');hash.update(buffer.subarray(0,bytesRead));let written=0;
    while(written<bytesRead){signal.throwIfAborted();const result=await file.write(buffer,written,bytesRead-written,position+written);if(!result.bytesWritten)throw new Error('Published file write stalled');written+=result.bytesWritten;}position+=bytesRead;
   }
   const after=await source.stat({bigint:true});signal.throwIfAborted();if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Published source changed during copy');
   const record:PublishedPrintFile=Object.freeze({version:1,id,name,sha256:hash.digest('hex'),size:position});
   await file.chmod(0o400);await file.sync();await file.close();file=undefined;signal.throwIfAborted();
   // Link is atomic and never replaces content already published under its digest.
   try{await link(temp,this.#path(record.sha256+'.gcode'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.#verifyExisting(record,signal);}
   await this.#root.sync();signal.throwIfAborted();
   receipt=await open(receiptTemp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await receipt.writeFile(JSON.stringify(record));await receipt.chmod(0o400);await receipt.sync();await receipt.close();receipt=undefined;signal.throwIfAborted();
   await link(receiptTemp,this.#path(id+'.json'));await this.#root.sync();return record;
  }catch(error){failure=error;throw error;}finally{
   const closed=await Promise.allSettled([file?.close(),receipt?.close()]);
   const removed=await Promise.allSettled([unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}),unlink(receiptTemp).catch(error=>{if(error.code!=='ENOENT')throw error;})]);
   const errors=[...closed,...removed].filter(result=>result.status==='rejected').map(result=>result.reason);
   if(errors.length)throw new AggregateError([...(failure===undefined?[]:[failure]),...errors],'Published file cleanup failed',{cause:failure});
  }
 });}
 acquire(id:string,signal:AbortSignal){return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();const record=await this.#record(id);signal.throwIfAborted();
  const source=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let snapshot:Awaited<ReturnType<typeof createSealedPrintReader>>|undefined;
  try{const stat=await source.stat();if(!stat.isFile()||stat.size!==record.size)throw new Error('Published content does not match receipt size');snapshot=await createSealedPrintReader(source,record.sha256,signal,{maxBytes:this.#maxBytes,budget:this.#budget});await source.close();return snapshot.reader;}
  catch(error){try{await source.close();}finally{await snapshot?.reader.close();}throw error;}
 });}
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  this.#closing=Promise.allSettled([...this.#pending]).then(()=>this.#root.close());return this.#closing;
 }
}
