import {createRequire} from 'node:module';
import {open,mkdir,link,unlink,opendir,lstat,statfs,readlink,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createSealedPrintReader,createSealedBinaryReader} from '../gcode/sealed-file.ts';
import {defaultPrintSnapshotBudget,type PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {lockDirectory(fd:number):void};
export interface PublishedPrintFile {readonly version:1;readonly id:string;readonly sha256:string;readonly size:number;readonly name:string;}
export class PublishedFileChangedError extends Error {}
/** Identity of the durable receipt, never the content blob or a temporary memfd. */
export interface PublishedSourceIdentity {readonly dev:bigint;readonly ino:bigint;readonly mtimeNs:bigint;readonly ctimeNs:bigint;}
export interface PublishedFileChange {readonly action:'create_file'|'delete_file';readonly file:PublishedPrintFile;readonly modified:number;}
interface StoredReceipt {sha256:string;size:number;receiptBytes:number;record:PublishedPrintFile;modified:number;}
interface StorageOperation {exclusive:boolean;start:()=>void;}
/** Private flat storage. Caller authenticates/authorizes IDs; no client paths.
 * Content and receipts are immutable publications. Root descriptor anchors IO. */
export class PublishedPrintFiles {
 #storedBytes=0;#reservedBytes=0;#records=new Map<string,StoredReceipt>();#references=new Map<string,number>();#publishing=new Set<string>();#maxStorage:number;#maxFiles:number;#writeFault:unknown;
 #queue:StorageOperation[]=[];#active=0;#exclusive=false;
 #root:FileHandle;#maxBytes:number;#maxOperations:number;#budget:PrintSnapshotBudget;
 #pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;
 readonly #observers=new Set<(change:PublishedFileChange)=>void>();#observerFailures=0;
 /** Internal synchronous commit observers. Transport delivery must enqueue work
  * without awaiting clients; an observer failure cannot undo durable storage. */
 observeChanges(observer:(change:PublishedFileChange)=>void):()=>void{
  if(this.#closed||typeof observer!=='function'||this.#observers.size>=8||this.#observers.has(observer))throw new Error('Published change observer unavailable');
  this.#observers.add(observer);return ()=>{this.#observers.delete(observer);};
 }
 get changeObservers(){return {count:this.#observers.size,failures:this.#observerFailures};}
 #changed(action:PublishedFileChange['action'],file:PublishedPrintFile,modified:number):void{const event=Object.freeze({action,file,modified});for(const observer of [...this.#observers]){try{observer(event);}catch{this.#observerFailures++;}}}
 private constructor(root:FileHandle,maxBytes:number,maxOperations:number,budget:PrintSnapshotBudget,maxStorage:number,maxFiles:number){this.#maxStorage=maxStorage;this.#maxFiles=maxFiles;this.#root=root;this.#maxBytes=maxBytes;this.#maxOperations=maxOperations;this.#budget=budget;}
 static async open(directory:string,options:{maxFileBytes?:number;maxOperations?:number;budget?:PrintSnapshotBudget;maxStorageBytes?:number;maxPublishedFiles?:number}={}):Promise<PublishedPrintFiles>{
  const max=options.maxFileBytes??64*1024**2,count=options.maxOperations??8,storage=options.maxStorageBytes??1024**3,files=options.maxPublishedFiles??1024;
  if(typeof directory!=='string'||!isAbsolute(directory)||!Number.isSafeInteger(max)||max<1||max>1024**3||!Number.isSafeInteger(count)||count<1||count>64)throw new RangeError('Invalid published file store configuration');
  if(!Number.isSafeInteger(storage)||storage<1||storage>1024**4||!Number.isSafeInteger(files)||files<1||files>10000)throw new RangeError('Invalid published storage quota');
  await mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
  const root=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{const stat=await root.stat();if(stat.uid!==process.getuid!()||(stat.mode&0o077)!==0)throw new Error('Published file directory must be private and owned by service');native.lockDirectory(root.fd);const store=new PublishedPrintFiles(root,max,count,options.budget??defaultPrintSnapshotBudget,storage,files);await store.#recover();return store;}catch(error){await root.close();throw error;}
 }
 get status(){return {storedBytes:this.#storedBytes,reservedBytes:this.#reservedBytes,publishedFiles:this.#records.size,pendingPublications:this.#publishing.size,maxStorageBytes:this.#maxStorage,maxPublishedFiles:this.#maxFiles,writeFault:this.#writeFault,closed:this.#closed,pendingOperations:this.#pending.size,maxFileBytes:this.#maxBytes,maxOperations:this.#maxOperations};}
 async directoryPath(signal:AbortSignal):Promise<string>{signal.throwIfAborted();if(this.#closed)throw new Error('Published files closed');const path=await readlink(`/proc/self/fd/${this.#root.fd}`);signal.throwIfAborted();return path;}
 async #recover():Promise<void>{
  const blobs=new Map<string,number>(),receipts=new Map<string,number>(),temporary:string[]=[];let count=0;
  const directory=await opendir(this.#path('.'));
  for await(const entry of directory){
   if(++count>32768)throw new Error('Published directory entry limit exceeded');
   const stat=await lstat(this.#path(entry.name));if(!stat.isFile()||stat.uid!==process.getuid!()||!Number.isSafeInteger(stat.size)||stat.size>1024**3)throw new Error('Unexpected published storage entry');
   if(/^[a-f0-9]{64}\.gcode$/.test(entry.name))blobs.set(entry.name,stat.size);
   else if(/^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name))receipts.set(entry.name,stat.size);
   else if(/^\.(?:upload|receipt)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name))temporary.push(entry.name);
   else throw new Error('Unknown published storage entry');
  }
  const referenced=new Set<string>();let receiptBytes=0;
  // Validate ALL references before deleting anything, including temporary names.
  for(const [name,size] of receipts){const id=name.slice(0,-5),record=await this.#record(id),blob=record.sha256+'.gcode';if(blobs.get(blob)!==record.size)throw new Error('Published receipt references missing or invalid content');referenced.add(blob);this.#records.set(id,{sha256:record.sha256,size:record.size,receiptBytes:size,record,modified:(await lstat(this.#path(name))).mtimeMs/1000});this.#references.set(record.sha256,(this.#references.get(record.sha256)??0)+1);receiptBytes+=size;}
  const garbage=[...temporary,...[...blobs.keys()].filter(name=>!referenced.has(name))];
  for(const name of garbage)await unlink(this.#path(name));if(garbage.length)await this.#root.sync();
  this.#storedBytes=receiptBytes+[...referenced].reduce((total,name)=>total+blobs.get(name)!,0);
 }
 #id(id:string):void{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('Invalid published file identifier');}
 #path(name:string):string{return `/proc/self/fd/${this.#root.fd}/${name}`;}
 #run<T>(operation:()=>Promise<T>,exclusive=false,signal?:AbortSignal):Promise<T>{
  if(this.#closed)return Promise.reject(new Error('Published file store is closed'));
  if(this.#pending.size>=this.#maxOperations)return Promise.reject(new Error('Published file operation limit exceeded'));
  if(signal?.aborted)return Promise.reject(signal.reason);
  const result=Promise.withResolvers<T>();
  const finish=()=>{this.#pending.delete(result.promise);this.#active--;if(exclusive)this.#exclusive=false;this.#drain();};
  const queued:StorageOperation={exclusive,start:()=>{
   signal?.removeEventListener('abort',cancel);this.#active++;if(exclusive)this.#exclusive=true;
   void Promise.resolve().then(operation).then(value=>{finish();result.resolve(value);},error=>{finish();result.reject(error);});
  }};
  const cancel=()=>{const index=this.#queue.indexOf(queued);if(index<0)return;this.#queue.splice(index,1);this.#pending.delete(result.promise);signal?.removeEventListener('abort',cancel);result.reject(signal!.reason);this.#drain();};
  this.#pending.add(result.promise);this.#queue.push(queued);signal?.addEventListener('abort',cancel,{once:true});this.#drain();return result.promise;
 }
 #drain():void{
  while(!this.#exclusive&&this.#queue.length){
   const next=this.#queue[0];if(next.exclusive&&this.#active)return;
   this.#queue.shift();next.start();
  }
 }
 async #record(id:string):Promise<PublishedPrintFile>{return (await this.#receipt(id)).file;}
 async #receipt(id:string,capture=false):Promise<{file:PublishedPrintFile;source?:PublishedSourceIdentity}>{
  const file=await open(this.#path(id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stat=await file.stat({bigint:true});if(!stat.isFile()||stat.size>2048n)throw new Error('Invalid published file receipt');
   const buffer=Buffer.alloc(2049),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>2048)throw new Error('Published receipt exceeds limit');
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead))) as PublishedPrintFile;
   if(value===null||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.id!==id||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<0||value.size>this.#maxBytes||typeof value.name!=='string'||!value.name||value.name.length>256||/[\u0000-\u001f\u007f]/u.test(value.name))throw new Error('Invalid published file receipt');
   let source:PublishedSourceIdentity|undefined;
   if(capture){const after=await file.stat({bigint:true});if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==BigInt(bytesRead)||stat.size!==after.size||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw new PublishedFileChangedError('Published receipt changed while reading its identity');source=Object.freeze({dev:stat.dev,ino:stat.ino,mtimeNs:stat.mtimeNs,ctimeNs:stat.ctimeNs});}
   return {file:Object.freeze({version:1,id,sha256:value.sha256,size:value.size,name:value.name}),...source?{source}:{}};
  }finally{await file.close();}
 }
 async #verifyExisting(record:PublishedPrintFile,signal:AbortSignal):Promise<void>{
  const file=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||stat.size!==record.size)throw new Error('Existing published content is invalid');const buffer=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
   while(position<record.size){signal.throwIfAborted();const {bytesRead}=await file.read(buffer,0,Math.min(buffer.length,record.size-position),position);if(!bytesRead)throw new Error('Existing published content is truncated');hash.update(buffer.subarray(0,bytesRead));position+=bytesRead;}
   signal.throwIfAborted();if(hash.digest('hex')!==record.sha256)throw new Error('Existing published content digest mismatch');
  }finally{await file.close();}
 }
 /** Snapshot known receipt IDs behind the mutation barrier. This is an inventory,
  * not a claim that every receipt is still referenced by higher-level metadata. */
 listIds(signal:AbortSignal):Promise<readonly string[]>{return this.#run(async()=>{signal.throwIfAborted();if(this.#writeFault)throw new Error('Published inventory requires recovery',{cause:this.#writeFault});return Object.freeze([...this.#records.keys()].sort());},true,signal);}
 /** Cached immutable receipt catalog, atomically observed after in-flight mutations.
  * It is discovery data only: acquisition still revalidates receipt and content. */
 catalog(signal:AbortSignal):Promise<readonly {file:PublishedPrintFile;modified:number}[]>{return this.#run(async()=>{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published inventory requires recovery',{cause:this.#writeFault});
  return Object.freeze([...this.#records].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,entry])=>Object.freeze({file:entry.record,modified:entry.modified})));
 },true,signal);}
 describe(id:string,signal:AbortSignal):Promise<{file:PublishedPrintFile;modified:number}>{return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();const stored=this.#records.get(id);if(!stored)throw Object.assign(new Error('Published file not found'),{code:'ENOENT'});
  const file=await this.#record(id);signal.throwIfAborted();if(file.sha256!==stored.record.sha256||file.name!==stored.record.name||file.size!==stored.record.size)throw new Error('Published receipt changed outside store');return {file,modified:stored.modified};
 },true,signal);}
 /** Source identity is sampled with the receipt bytes from the same no-follow
  * descriptor behind the mutation barrier. Ordinary cached reads avoid the
  * extra fingerprint validation syscall. Callers still verify content bytes. */
 describeSource(id:string,signal:AbortSignal):Promise<{file:PublishedPrintFile;modified:number;source:PublishedSourceIdentity}>{return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published source requires recovery',{cause:this.#writeFault});
  const stored=this.#records.get(id);if(!stored)throw Object.assign(new Error('Published file not found'),{code:'ENOENT'});
  const result=await this.#receipt(id,true);signal.throwIfAborted();if(result.file.sha256!==stored.record.sha256||result.file.name!==stored.record.name||result.file.size!==stored.record.size)throw new PublishedFileChangedError('Published receipt changed outside store');return {file:result.file,modified:stored.modified,source:result.source!};
 },true,signal);}
 diskUsage(signal:AbortSignal):Promise<{total:number;used:number;free:number}>{return this.#run(async()=>{signal.throwIfAborted();const fs=await statfs(this.#path('.'),{bigint:true});signal.throwIfAborted();const result={total:Number(fs.blocks*fs.bsize),used:Number((fs.blocks-fs.bfree)*fs.bsize),free:Number(fs.bavail*fs.bsize)};if(Object.values(result).some(value=>!Number.isSafeInteger(value)||value<0))throw new Error('Disk usage exceeds exact JSON integer range');return result;},false,signal);}
 inspect(id:string):Promise<PublishedPrintFile>{return this.#run(async()=>{this.#id(id);return this.#record(id);});}
 /** Bounded binary acquisition for non-G-code owners. The returned Buffer is an
  * independent verified snapshot; it never enters the text G-code reader. */
 readBytes(id:string,signal:AbortSignal,maxBytes=8*1024**2):Promise<{record:PublishedPrintFile;bytes:Buffer}>{return this.#run(async()=>{
  this.#id(id);if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024**2)throw new RangeError('Invalid published binary read limit');signal.throwIfAborted();
  const record=await this.#record(id);if(record.size>maxBytes)throw new Error('Published binary read limit exceeded');
  const file=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat({bigint:true});if(!before.isFile()||before.size!==BigInt(record.size))throw new Error('Published binary content size mismatch');
   const bytes=Buffer.allocUnsafe(record.size),hash=createHash('sha256');let position=0;
   while(position<bytes.length){signal.throwIfAborted();const {bytesRead}=await file.read(bytes,position,Math.min(65536,bytes.length-position),position);signal.throwIfAborted();if(!bytesRead)throw new Error('Published binary content truncated');hash.update(bytes.subarray(position,position+bytesRead));position+=bytesRead;}
   const after=await file.stat({bigint:true});signal.throwIfAborted();if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||hash.digest('hex')!==record.sha256)throw new Error('Published binary content changed or digest mismatch');
   return {record,bytes};
  }finally{await file.close();}
 },false,signal);}
 publish(id:string,name:string,source:FileHandle,signal:AbortSignal):Promise<PublishedPrintFile>{return this.#run(async()=>{
  this.#id(id);if(this.#writeFault)throw new Error('Published writes require recovery',{cause:this.#writeFault});if(this.#records.has(id)||this.#publishing.has(id))throw Object.assign(new Error('Published identifier already exists'),{code:'EEXIST'});if(typeof name!=='string'||!name||name.length>256||/[\u0000-\u001f\u007f]/u.test(name))throw new Error('Invalid published file name');signal.throwIfAborted();
  const before=await source.stat({bigint:true});signal.throwIfAborted();if(!before.isFile()||before.size>BigInt(this.#maxBytes))throw new Error('Published source exceeds regular file limit');
  if(this.#records.has(id)||this.#publishing.has(id))throw Object.assign(new Error('Published identifier already exists'),{code:'EEXIST'});
  let reserved=Number(before.size)+2048;if(this.#records.size+this.#publishing.size>=this.#maxFiles||reserved>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published storage quota exceeded');
  const temp=this.#path('.upload-'+randomUUID()),receiptTemp=this.#path('.receipt-'+randomUUID());let file:FileHandle|undefined,receipt:FileHandle|undefined,failure:unknown;
  this.#reservedBytes+=reserved;this.#publishing.add(id);
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
   try{await link(temp,this.#path(record.sha256+'.gcode'));this.#storedBytes+=position;this.#reservedBytes-=position;reserved-=position;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.#verifyExisting(record,signal);}
   await this.#root.sync();signal.throwIfAborted();
   receipt=await open(receiptTemp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await receipt.writeFile(JSON.stringify(record));await receipt.chmod(0o400);await receipt.sync();const modified=(await receipt.stat()).mtimeMs/1000;await receipt.close();receipt=undefined;signal.throwIfAborted();
   await link(receiptTemp,this.#path(id+'.json'));const receiptBytes=Buffer.byteLength(JSON.stringify(record));this.#storedBytes+=receiptBytes;this.#reservedBytes-=receiptBytes;reserved-=receiptBytes;this.#records.set(id,{sha256:record.sha256,size:record.size,receiptBytes,record,modified});this.#references.set(record.sha256,(this.#references.get(record.sha256)??0)+1);this.#publishing.delete(id);await this.#root.sync();this.#changed('create_file',record,modified);return record;
  }catch(error){failure=error;throw error;}finally{
   const closed=await Promise.allSettled([file?.close(),receipt?.close()]);
   const removed=await Promise.allSettled([unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}),unlink(receiptTemp).catch(error=>{if(error.code!=='ENOENT')throw error;})]);
   const errors=[...closed,...removed].filter(result=>result.status==='rejected').map(result=>result.reason);
   this.#publishing.delete(id);
   if(errors.length){this.#writeFault=new AggregateError([...(failure===undefined?[]:[failure]),...errors],'Published file cleanup failed',{cause:failure});throw this.#writeFault;}
   this.#reservedBytes-=reserved;
  }
 },false,signal);}
 acquire(id:string,signal:AbortSignal){return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();const record=await this.#record(id);signal.throwIfAborted();
  const source=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let snapshot:Awaited<ReturnType<typeof createSealedPrintReader>>|undefined;
  try{const stat=await source.stat();if(!stat.isFile()||stat.size!==record.size)throw new Error('Published content does not match receipt size');snapshot=await createSealedPrintReader(source,record.sha256,signal,{maxBytes:this.#maxBytes,budget:this.#budget});await source.close();return snapshot.reader;}
  catch(error){try{await source.close();}finally{await snapshot?.reader.close();}throw error;}
 },false,signal);}
 /** Binary download owns an independent sealed snapshot and a separate quota. */
 acquireBinary(id:string,signal:AbortSignal,budget:PrintSnapshotBudget){return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();const record=await this.#record(id);signal.throwIfAborted();
  const source=await open(this.#path(record.sha256+'.gcode'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let snapshot:Awaited<ReturnType<typeof createSealedBinaryReader>>|undefined;
  try{const stat=await source.stat();if(!stat.isFile()||stat.size!==record.size)throw new Error('Published content does not match receipt size');snapshot=await createSealedBinaryReader(source,record.sha256,signal,{maxBytes:this.#maxBytes,budget});await source.close();return {record,...snapshot};}
  catch(error){try{await source.close();}finally{await snapshot?.reader.close();}throw error;}
 },false,signal);}
 /** Remove the receipt durably before reclaiming its last content reference.
  * Readers already returned own sealed snapshots independent of this store. */
 remove(id:string,signal:AbortSignal,expected?:PublishedPrintFile):Promise<PublishedPrintFile>{return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();
  if(this.#writeFault)throw new Error('Published writes require recovery',{cause:this.#writeFault});
  const stored=this.#records.get(id);
  if(!stored)throw Object.assign(new Error('Published identifier does not exist'),{code:'ENOENT'});
  const record=await this.#record(id),receipt=await lstat(this.#path(id+'.json'));
  if(record.sha256!==stored.sha256||record.size!==stored.size||record.name!==stored.record.name||!receipt.isFile()||receipt.size!==stored.receiptBytes)throw new Error('Published receipt changed outside store');
  if(expected&&(record.id!==expected.id||record.sha256!==expected.sha256||record.size!==expected.size||record.name!==expected.name))throw new PublishedFileChangedError('Authorized file changed before removal');
  const references=this.#references.get(stored.sha256);
  if(!references)throw new Error('Published content reference invariant failed');
  signal.throwIfAborted();let removed=false;
  try{
   await unlink(this.#path(id+'.json'));removed=true;this.#records.delete(id);
   // Never delete content until the absence of its receipt is durable.
   // After unlink begins, finish durability even if cancellation arrives.
   await this.#root.sync();this.#storedBytes-=stored.receiptBytes;
   if(references>1)this.#references.set(stored.sha256,references-1);
   else{
    this.#references.delete(stored.sha256);await unlink(this.#path(stored.sha256+'.gcode'));
    await this.#root.sync();this.#storedBytes-=stored.size;
   }
   this.#changed('delete_file',record,0);return record;
  }catch(error){if(removed)this.#writeFault=error;throw error;}
 },true,signal);}
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  this.#closing=Promise.allSettled([...this.#pending]).then(()=>{this.#observers.clear();return this.#root.close();});return this.#closing;
 }
}
