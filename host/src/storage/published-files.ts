import {createRequire} from 'node:module';
import {open,mkdir,link,unlink,rename,opendir,lstat,statfs,readlink,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {createSealedPrintReader,createSealedBinaryReader} from '../gcode/sealed-file.ts';
import {defaultPrintSnapshotBudget,type PrintSnapshotBudget} from '../gcode/snapshot-budget.ts';
import {publishedPath,visibleFilePath,pathParent,pathBasename,PublishedDirectoryCommitError} from './published-paths.ts';
import {planNamespaceMove,validateMoveIntent,recoverMoveRecords,sameNamespaceMove,samePublishedFile,type NamespaceMove} from './namespace-move.ts';
import {planNamespaceCopy,validateCopyIntent,recoverCopyRecords,sameNamespaceCopy,type NamespaceCopy} from './namespace-copy.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {lockDirectory(fd:number):void};
export interface PublishedPrintFile {readonly version:1;readonly id:string;readonly sha256:string;readonly size:number;readonly name:string;readonly path?:string;}
export class PublishedFileChangedError extends Error {}
export class PublishedFileMoveCommitError extends Error {
 readonly phase:'before-replace'|'replaced';
 constructor(phase:'before-replace'|'replaced',cause:unknown){super('File move requires recovery',{cause});this.phase=phase;}
}
export interface PublishedFileMove {readonly before:PublishedPrintFile;readonly after:PublishedPrintFile;readonly modified:number;}
export class PublishedNamespaceMoveCommitError extends Error {
 readonly phase:'before-intent'|'intent-published';
 constructor(phase:'before-intent'|'intent-published',cause:unknown){super('Directory move requires recovery',{cause});this.phase=phase;}
}
/** Identity of the durable receipt, never the content blob or a temporary memfd. */
export interface PublishedSourceIdentity {readonly dev:bigint;readonly ino:bigint;readonly mtimeNs:bigint;readonly ctimeNs:bigint;}
export interface PublishedFileChange {readonly action:'create_file'|'modify_file'|'delete_file'|'move_file';readonly file:PublishedPrintFile;readonly modified:number;readonly sourceFile?:PublishedPrintFile;}
export class PublishedCopyCommitError extends Error {
 readonly phase:'before-intent'|'intent-published';
 constructor(phase:'before-intent'|'intent-published',cause:unknown){super('Copy requires recovery',{cause});this.phase=phase;}
}
interface StoredReceipt {sha256:string;size:number;receiptBytes:number;record:PublishedPrintFile;modified:number;}
interface StorageOperation {exclusive:boolean;start:()=>void;}
export interface PublishedDirectoryChange {readonly action:'create_dir'|'delete_dir'|'move_dir';readonly path:string;readonly modified:number;readonly sourcePath?:string;}
/** Private flat storage behind a separate visible namespace. Clients never
 * supply blob/receipt filesystem paths; callers authenticate/authorize IDs.
 * Content and receipts are immutable publications. Root descriptor anchors IO. */
export class PublishedPrintFiles {
 #storedBytes=0;#reservedBytes=0;#records=new Map<string,StoredReceipt>();#references=new Map<string,number>();#publishing=new Set<string>();#maxStorage:number;#maxFiles:number;#writeFault:unknown;
 #queue:StorageOperation[]=[];#active=0;#exclusive=false;
 #paths=new Map<string,string>();#publishingPaths=new Set<string>();#directories=new Map<string,number>();#directoryBytes=0;
 #root:FileHandle;#maxBytes:number;#maxOperations:number;#budget:PrintSnapshotBudget;
 #pending=new Set<Promise<unknown>>();#closed=false;#closing:Promise<void>|undefined;
 readonly #observers=new Set<(change:PublishedFileChange)=>void>();#observerFailures=0;
 readonly #directoryObservers=new Set<(change:PublishedDirectoryChange)=>void>();
 readonly #fileMoves=new WeakMap<PublishedFileMove,string>();
 readonly #directoryMoves=new WeakMap<NamespaceMove,string>();
 readonly #copies=new WeakMap<NamespaceCopy,string>();
 #cachedNamespaceWindow=false;
 observeDirectories(observer:(change:PublishedDirectoryChange)=>void):()=>void{if(this.#closed||typeof observer!=='function'||this.#directoryObservers.size>=8||this.#directoryObservers.has(observer))throw new Error('Published directory observer unavailable');this.#directoryObservers.add(observer);return ()=>this.#directoryObservers.delete(observer);}
 /** Internal synchronous commit observers. Transport delivery must enqueue work
  * without awaiting clients; an observer failure cannot undo durable storage. */
 observeChanges(observer:(change:PublishedFileChange)=>void):()=>void{
  if(this.#closed||typeof observer!=='function'||this.#observers.size>=8||this.#observers.has(observer))throw new Error('Published change observer unavailable');
  this.#observers.add(observer);return ()=>{this.#observers.delete(observer);};
 }
 get changeObservers(){return {count:this.#observers.size,failures:this.#observerFailures};}
 #changed(action:PublishedFileChange['action'],file:PublishedPrintFile,modified:number,sourceFile?:PublishedPrintFile):void{const event=Object.freeze({action,file,modified,...sourceFile?{sourceFile}:{}});for(const observer of [...this.#observers]){try{observer(event);}catch{this.#observerFailures++;}}}
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
  const blobs=new Map<string,number>(),receipts=new Map<string,number>(),temporary:string[]=[];let count=0,intent:NamespaceMove|undefined,copyIntent:NamespaceCopy|undefined;
  const directory=await opendir(this.#path('.'));
  for await(const entry of directory){
   if(++count>32768)throw new Error('Published directory entry limit exceeded');
   const stat=await lstat(this.#path(entry.name));if(!stat.isFile()||stat.uid!==process.getuid!()||!Number.isSafeInteger(stat.size)||stat.size>1024**3)throw new Error('Unexpected published storage entry');
   if(/^[a-f0-9]{64}\.gcode$/.test(entry.name))blobs.set(entry.name,stat.size);
   else if(entry.name==='.directories.json')await this.#loadDirectories();
   else if(entry.name==='.namespace-move.json')intent=await this.#loadMoveIntent();
   else if(entry.name==='.namespace-copy.json')copyIntent=await this.#loadCopyIntent();
   else if(/^[A-Za-z0-9_-]{1,128}\.json$/.test(entry.name))receipts.set(entry.name,stat.size);
   else if(/^\.directories-[a-f0-9-]{36}$/.test(entry.name))temporary.push(entry.name);
   else if(/^\.(?:upload|receipt|move|copy)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(entry.name))temporary.push(entry.name);
   else throw new Error('Unknown published storage entry');
  }
  if(intent&&copyIntent)throw new Error('Conflicting namespace intents');
  if(copyIntent){
   const files:PublishedPrintFile[]=[];for(const [name] of receipts){const record=await this.#record(name.slice(0,-5));if(blobs.get(record.sha256+'.gcode')!==record.size)throw new Error('Copy recovery content reference is invalid');files.push(record);}
   recoverCopyRecords(copyIntent,files,this.#directories);
   await this.#applyCopy(copyIntent);this.#directories.clear();this.#directoryBytes=0;await this.#recover();return;
  }
  if(intent){
   const files:PublishedPrintFile[]=[];
   for(const [name] of receipts){const record=await this.#record(name.slice(0,-5));if(blobs.get(record.sha256+'.gcode')!==record.size)throw new Error('Move recovery content reference is invalid');files.push(record);}
   recoverMoveRecords(intent,files,this.#directories);
   await this.#applyDirectoryMove(intent);
   this.#directories.clear();this.#directoryBytes=0;
   await this.#recover();return;
  }
  const referenced=new Set<string>();let receiptBytes=0;
  // Validate ALL references before deleting anything, including temporary names.
  for(const [name,size] of receipts){const id=name.slice(0,-5),record=await this.#record(id),blob=record.sha256+'.gcode',path=visibleFilePath(record);if(blobs.get(blob)!==record.size||this.#paths.has(path)||this.#directories.has(path)||pathParent(path)&&!this.#directories.has(pathParent(path)))throw new Error('Published receipt namespace or content is invalid');this.#paths.set(path,id);referenced.add(blob);this.#records.set(id,{sha256:record.sha256,size:record.size,receiptBytes:size,record,modified:(await lstat(this.#path(name))).mtimeMs/1000});this.#references.set(record.sha256,(this.#references.get(record.sha256)??0)+1);receiptBytes+=size;}
  for(const path of this.#directories.keys())if(this.#paths.has(path))throw new Error('Directory collides with a published file');
  const garbage=[...temporary,...[...blobs.keys()].filter(name=>!referenced.has(name))];
  for(const name of garbage)await unlink(this.#path(name));if(garbage.length)await this.#root.sync();
  this.#storedBytes=this.#directoryBytes+receiptBytes+[...referenced].reduce((total,name)=>total+blobs.get(name)!,0);
 }
 async #loadMoveIntent():Promise<NamespaceMove>{
  const file=await open(this.#path('.namespace-move.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(process.getuid!())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>48n*1024n**2n)throw new Error('Invalid move intent file');const bytes=await file.readFile();const after=await file.stat({bigint:true});if(BigInt(bytes.length)!==before.size||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Move intent changed while reading');return validateMoveIntent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}finally{await file.close();}
 }
 async #verifyDirectoryAuthority(...catalogs:NamespaceMove['directoriesBefore'][]):Promise<void>{
  const file=await open(this.#path('.directories.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(process.getuid!())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>2n*1024n**2n)throw new PublishedFileChangedError('Directory authority is invalid');const bytes=await file.readFile(),after=await file.stat({bigint:true});if(BigInt(bytes.length)!==before.size||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs||!catalogs.some(directories=>bytes.equals(Buffer.from(JSON.stringify({version:1,directories})))))throw new PublishedFileChangedError('Directory catalog changed outside transaction');}finally{await file.close();}
 }
 /** The durable intent is the decision. Each replay is idempotent and may
  * finish an old/new receipt mixture; cancellation never abandons that decision.
  * Caller validates the complete namespace and content references first. */
 async #applyDirectoryMove(plan:NamespaceMove):Promise<void>{
  await this.#verifyDirectoryAuthority(plan.directoriesBefore,plan.directoriesAfter);
  for(const entry of plan.changed){
   const current=(await this.#receipt(entry.before.id)).file;
   if(samePublishedFile(current,entry.after))continue;
   if(!samePublishedFile(current,entry.before))throw new PublishedFileChangedError('Directory move receipt changed');
   const path=this.#path('.receipt-'+randomUUID()),file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(JSON.stringify(entry.after));await file.utimes(entry.modified,entry.modified);await file.chmod(0o400);await file.sync();}finally{await file.close();}
   await rename(path,this.#path(entry.before.id+'.json'));
  }
  await this.#root.sync();
  await this.#verifyDirectoryAuthority(plan.directoriesBefore,plan.directoriesAfter);
  const path=this.#path('.directories-'+randomUUID()),file=await open(path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  try{await file.writeFile(JSON.stringify({version:1,directories:plan.directoriesAfter}));await file.sync();}finally{await file.close();}
  await rename(path,this.#path('.directories.json'));await this.#root.sync();
  await unlink(this.#path('.namespace-move.json'));await this.#root.sync();
 }
 prepareDirectoryMove(source:string,destination:string,signal:AbortSignal):Promise<NamespaceMove>{return this.#run(async()=>{
  this.#cachedNamespaceWindow=true;try{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');
  const plan=planNamespaceMove(source,destination,[...this.#records.values()].map(e=>({file:e.record,modified:e.modified})),this.#directories);
  for(const entry of plan.changed){signal.throwIfAborted();if(!samePublishedFile(await this.#record(entry.before.id),entry.before))throw new PublishedFileChangedError('Directory move source changed outside store');}
  this.#directoryMoves.set(plan,destination);signal.throwIfAborted();return plan;
  }finally{this.#cachedNamespaceWindow=false;}
 },true,signal);}
 moveDirectory(plan:NamespaceMove,signal:AbortSignal):Promise<PublishedDirectoryChange>{return this.#run(async()=>{
  this.#cachedNamespaceWindow=true;try{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');const destination=this.#directoryMoves.get(plan);if(destination===undefined)throw new Error('Directory move plan belongs to another store');
  const current=planNamespaceMove(plan.source,destination,[...this.#records.values()].map(e=>({file:e.record,modified:e.modified})),this.#directories);
  if(!sameNamespaceMove(current,plan))throw new PublishedFileChangedError('Authorized directory membership or destination changed');
  // Encode in small chunks and yield between groups instead of serializing a
  // 10,000-receipt journal as one synchronous event-loop operation.
  const chunks:Buffer[]=[Buffer.from(JSON.stringify({version:1,action:'move_dir',source:plan.source,destination:plan.destination}).slice(0,-1)+',"changed":[')];let journalBytes=chunks[0].length,receiptDelta=0,receiptGrowth=0,maxReceipt=0;
  for(let i=0;i<plan.changed.length;i++){signal.throwIfAborted();const entry=plan.changed[i],bytes=Buffer.byteLength(JSON.stringify(entry.after));if(bytes>2048)throw new Error('Move receipt exceeds limit');const delta=bytes-this.#records.get(entry.before.id)!.receiptBytes;receiptDelta+=delta;receiptGrowth+=Math.max(0,delta);maxReceipt=Math.max(maxReceipt,bytes);const chunk=Buffer.from((i?',':'')+JSON.stringify(entry));journalBytes+=chunk.length;chunks.push(chunk);if(i%128===127)await new Promise<void>(resolve=>setImmediate(resolve));}
  const tail=Buffer.from('],"directoriesBefore":'+JSON.stringify(plan.directoriesBefore)+',"directoriesAfter":'+JSON.stringify(plan.directoriesAfter)+'}');journalBytes+=tail.length;chunks.push(tail);
  const directoryBytes=Buffer.byteLength(JSON.stringify({version:1,directories:plan.directoriesAfter}));
  const reserved=journalBytes+maxReceipt+directoryBytes+receiptGrowth+Math.max(0,directoryBytes-this.#directoryBytes);
  if(journalBytes>48*1024**2||directoryBytes>2*1024**2||reserved>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published directory move quota exceeded');
  const temp=this.#path('.move-'+randomUUID());let file:FileHandle|undefined,published=false,failure:unknown;this.#reservedBytes+=reserved;
  try{
   signal.throwIfAborted();file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);for(const chunk of chunks){signal.throwIfAborted();await file.writeFile(chunk);}await file.sync();await file.close();file=undefined;
   for(const entry of plan.changed){signal.throwIfAborted();if(!samePublishedFile(await this.#record(entry.before.id),entry.before))throw new PublishedFileChangedError('Directory move receipt changed before intent');}
   await this.#verifyDirectoryAuthority(plan.directoriesBefore);signal.throwIfAborted();await lstat(this.#path('.namespace-move.json')).then(()=>{throw new Error('Previous move intent requires recovery');},error=>{if(error.code!=='ENOENT')throw error;});
   await rename(temp,this.#path('.namespace-move.json'));published=true;await this.#root.sync();
   await this.#applyDirectoryMove(plan);
   const records=new Map(this.#records),paths=new Map(this.#paths);
   for(const entry of plan.changed){const old=records.get(entry.before.id)!;paths.delete(visibleFilePath(entry.before));const modified=(await lstat(this.#path(entry.before.id+'.json'))).mtimeMs/1000;records.set(entry.before.id,{...old,record:entry.after,receiptBytes:Buffer.byteLength(JSON.stringify(entry.after)),modified});}
   for(const entry of plan.changed)paths.set(visibleFilePath(entry.after),entry.after.id);this.#records=records;this.#paths=paths;
   this.#directories=new Map(plan.directoriesAfter.map(e=>[e.path,e.modified]));this.#storedBytes+=receiptDelta+directoryBytes-this.#directoryBytes;this.#directoryBytes=directoryBytes;
   const event=Object.freeze({action:'move_dir' as const,path:plan.destination,sourcePath:plan.source,modified:this.#directories.get(plan.destination)!});for(const observer of this.#directoryObservers)try{observer(event);}catch{this.#observerFailures++;}return event;
  }catch(error){failure=error;if(published)this.#writeFault=error;throw new PublishedNamespaceMoveCommitError(published?'intent-published':'before-intent',error);}
  finally{try{await file?.close();if(!published){await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});await this.#root.sync();}}catch(cleanup){this.#writeFault=new AggregateError([...(failure?[failure]:[]),cleanup],'Directory move cleanup failed');throw new PublishedNamespaceMoveCommitError(published?'intent-published':'before-intent',this.#writeFault);}finally{this.#reservedBytes-=reserved;}}
  }finally{this.#cachedNamespaceWindow=false;}
 },true,signal);}
 async #loadCopyIntent():Promise<NamespaceCopy>{
  const file=await open(this.#path('.namespace-copy.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const before=await file.stat({bigint:true});if(!before.isFile()||before.uid!==BigInt(process.getuid!())||before.nlink!==1n||(before.mode&0o7777n)!==0o600n||before.size>48n*1024n**2n)throw new Error('Invalid copy intent file');const bytes=await file.readFile(),after=await file.stat({bigint:true});if(BigInt(bytes.length)!==before.size||before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Copy intent changed while reading');return validateCopyIntent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));}finally{await file.close();}
 }
 async #copyDirectoryAuthority(plan:NamespaceCopy):Promise<void>{
  await this.#verifyDirectoryAuthority(plan.directoriesBefore,plan.directoriesAfter).catch(error=>{if(error.code!=='ENOENT'||plan.directoriesBefore.length)throw error;});
 }
 async #applyCopy(plan:NamespaceCopy):Promise<void>{
  await this.#copyDirectoryAuthority(plan);const verified=new Set<string>(),signal=new AbortController().signal;
  for(const entry of plan.entries){
   if(!samePublishedFile(await this.#record(entry.source.id),entry.source))throw new PublishedFileChangedError('Copy source receipt changed');
   if(!verified.has(entry.source.sha256)){await this.#verifyExisting(entry.source,signal);verified.add(entry.source.sha256);}
   const current=await this.#record(entry.created.id).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});
   if(current){if(!samePublishedFile(current,entry.created))throw new PublishedFileChangedError('Copy destination receipt changed');continue;}
   const temp=this.#path('.receipt-'+randomUUID()),file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(JSON.stringify(entry.created));await file.utimes(entry.modified,entry.modified);await file.chmod(0o400);await file.sync();}finally{await file.close();}
   // Never replace an unexpected receipt, even after interrupted replay.
   await link(temp,this.#path(entry.created.id+'.json'));await unlink(temp);
  }
  if(plan.replaced){const old=await this.#record(plan.replaced.id).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined;});if(old){if(!samePublishedFile(old,plan.replaced))throw new PublishedFileChangedError('Copy replaced receipt changed');await unlink(this.#path(plan.replaced.id+'.json'));}}
  await this.#root.sync();await this.#copyDirectoryAuthority(plan);
  if(JSON.stringify(plan.directoriesBefore)!==JSON.stringify(plan.directoriesAfter)){
   const temp=this.#path('.directories-'+randomUUID()),file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   try{await file.writeFile(JSON.stringify({version:1,directories:plan.directoriesAfter}));await file.sync();}finally{await file.close();}
   await rename(temp,this.#path('.directories.json'));await this.#root.sync();
  }
  await unlink(this.#path('.namespace-copy.json'));await this.#root.sync();
 }
 prepareCopy(source:string,destination:string,signal:AbortSignal):Promise<NamespaceCopy>{return this.#run(async()=>{
  this.#cachedNamespaceWindow=true;try{
   signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');
   const plan=planNamespaceCopy(source,destination,[...this.#records.values()].map(r=>({file:r.record,modified:r.modified})),this.#directories,()=>randomUUID(),Date.now()/1000);
   for(const entry of plan.entries){signal.throwIfAborted();if(!samePublishedFile(await this.#record(entry.source.id),entry.source))throw new PublishedFileChangedError('Copy source changed outside store');}
   this.#copies.set(plan,destination);return plan;
  }finally{this.#cachedNamespaceWindow=false;}
 },true,signal);}
 copy(plan:NamespaceCopy,signal:AbortSignal):Promise<NamespaceCopy>{return this.#run(async()=>{
  this.#cachedNamespaceWindow=true;try{
   signal.throwIfAborted();if(this.#writeFault)throw new Error('Published writes require recovery');const destination=this.#copies.get(plan);if(destination===undefined)throw new Error('Copy plan belongs to another store');
   const ids=new Map(plan.entries.map(e=>[e.source.id,e.created.id]));let current:NamespaceCopy;
   try{current=planNamespaceCopy(plan.source,destination,[...this.#records.values()].map(r=>({file:r.record,modified:r.modified})),this.#directories,f=>ids.get(f.id)!,plan.createdAt);}catch(cause){throw new PublishedFileChangedError('Authorized copy namespace changed',{cause});}
   if(!sameNamespaceCopy(current,plan))throw new PublishedFileChangedError('Authorized copy membership or destination changed');
   if(this.#records.size+plan.entries.length-(plan.replaced?1:0)>this.#maxFiles)throw new Error('Published copy file quota exceeded');
   const chunks=[Buffer.from(JSON.stringify({version:1,action:plan.action,source:plan.source,destination:plan.destination,createdAt:plan.createdAt}).slice(0,-1)+',"entries":[')];let journalBytes=chunks[0].length,receiptBytes=0,maxReceipt=0;
   for(const [i,entry] of plan.entries.entries()){signal.throwIfAborted();const bytes=Buffer.byteLength(JSON.stringify(entry.created));if(bytes>2048)throw new Error('Copy receipt exceeds limit');receiptBytes+=bytes;maxReceipt=Math.max(maxReceipt,bytes);const chunk=Buffer.from((i?',':'')+JSON.stringify(entry));journalBytes+=chunk.length;chunks.push(chunk);if(i%128===127)await new Promise<void>(resolve=>setImmediate(resolve));}
   const tail=Buffer.from(']'+(plan.replaced?',"replaced":'+JSON.stringify(plan.replaced):'')+',"directoriesBefore":'+JSON.stringify(plan.directoriesBefore)+',"directoriesAfter":'+JSON.stringify(plan.directoriesAfter)+'}');journalBytes+=tail.length;chunks.push(tail);
   const directoriesChanged=JSON.stringify(plan.directoriesBefore)!==JSON.stringify(plan.directoriesAfter),directoryBytes=directoriesChanged?Buffer.byteLength(JSON.stringify({version:1,directories:plan.directoriesAfter})):this.#directoryBytes;
   const reserved=journalBytes+receiptBytes+maxReceipt+(directoriesChanged?directoryBytes:0);if(journalBytes>48*1024**2||directoryBytes>2*1024**2||reserved>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published copy storage quota exceeded');
   const temp=this.#path('.copy-'+randomUUID());let file:FileHandle|undefined,published=false,failure:unknown;this.#reservedBytes+=reserved;
   try{
    signal.throwIfAborted();file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);for(const chunk of chunks){signal.throwIfAborted();await file.writeFile(chunk);}await file.sync();await file.close();file=undefined;
    for(const entry of plan.entries){signal.throwIfAborted();if(!samePublishedFile(await this.#record(entry.source.id),entry.source))throw new PublishedFileChangedError('Copy source changed before intent');}
    if(plan.replaced&&!samePublishedFile(await this.#record(plan.replaced.id),plan.replaced))throw new PublishedFileChangedError('Copy destination changed before intent');
    await this.#copyDirectoryAuthority(plan);signal.throwIfAborted();await lstat(this.#path('.namespace-copy.json')).then(()=>{throw new Error('Previous copy intent requires recovery');},error=>{if(error.code!=='ENOENT')throw error;});
    await rename(temp,this.#path('.namespace-copy.json'));published=true;await this.#root.sync();await this.#applyCopy(plan);
    const records=new Map(this.#records),paths=new Map(this.#paths),references=new Map(this.#references);let removedBytes=0,garbage:StoredReceipt|undefined;
    if(plan.replaced){const old=records.get(plan.replaced.id)!;records.delete(old.record.id);paths.delete(visibleFilePath(old.record));removedBytes=old.receiptBytes;const count=references.get(old.sha256)!-1;if(count)references.set(old.sha256,count);else{references.delete(old.sha256);garbage=old;}}
    for(const entry of plan.entries){const record=entry.created,modified=(await lstat(this.#path(record.id+'.json'))).mtimeMs/1000;records.set(record.id,{sha256:record.sha256,size:record.size,record,modified,receiptBytes:Buffer.byteLength(JSON.stringify(record))});paths.set(visibleFilePath(record),record.id);references.set(record.sha256,(references.get(record.sha256)??0)+1);}
    this.#records=records;this.#paths=paths;this.#references=references;this.#directories=new Map(plan.directoriesAfter.map(d=>[d.path,d.modified]));this.#storedBytes+=receiptBytes-removedBytes+directoryBytes-this.#directoryBytes;this.#directoryBytes=directoryBytes;
    if(garbage&&!references.has(garbage.sha256)){await unlink(this.#path(garbage.sha256+'.gcode'));await this.#root.sync();this.#storedBytes-=garbage.size;}
    this.#copies.delete(plan);
    for(const entry of plan.entries)this.#changed(plan.action==='modify_file'?'modify_file':'create_file',entry.created,records.get(entry.created.id)!.modified);
    if(plan.action==='create_dir'){const event=Object.freeze({action:'create_dir' as const,path:plan.destination,modified:this.#directories.get(plan.destination)!});for(const observer of this.#directoryObservers)try{observer(event);}catch{this.#observerFailures++;}}
    return plan;
   }catch(error){failure=error;if(published)this.#writeFault=error;throw new PublishedCopyCommitError(published?'intent-published':'before-intent',error);}
   finally{try{await file?.close();if(!published){await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});await this.#root.sync();}}catch(cleanup){this.#writeFault=new AggregateError([...(failure?[failure]:[]),cleanup],'Copy cleanup failed');throw new PublishedCopyCommitError(published?'intent-published':'before-intent',this.#writeFault);}finally{this.#reservedBytes-=reserved;}}
  }finally{this.#cachedNamespaceWindow=false;}
 },true,signal);}
 async #loadDirectories():Promise<void>{
  const file=await open(this.#path('.directories.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid!()||stat.nlink!==1||(stat.mode&0o7777)!==0o600||stat.size>2*1024**2)throw new Error('Invalid published directory metadata');const buffer=Buffer.alloc(stat.size+1);let at=0;while(at<buffer.length){const r=await file.read(buffer,at,buffer.length-at,at);if(!r.bytesRead)break;at+=r.bytesRead;}if(at!==stat.size)throw new Error('Directory metadata changed while reading');
   const data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,at)));if(!data||data.version!==1||Object.keys(data).some(k=>!['version','directories'].includes(k))||!Array.isArray(data.directories)||data.directories.length>1024)throw new Error('Invalid directory metadata schema');
   for(const entry of data.directories){const path=publishedPath(entry?.path);if(Object.keys(entry).some(k=>!['path','modified'].includes(k))||!Number.isFinite(entry.modified)||entry.modified<0||this.#directories.has(path))throw new Error('Invalid directory metadata entry');this.#directories.set(path,entry.modified);}
   for(const path of this.#directories.keys())if(pathParent(path)&&!this.#directories.has(pathParent(path)))throw new Error('Published directory parent is missing');this.#directoryBytes=stat.size;
  }finally{await file.close();}
 }
 async #commitDirectories(next:Map<string,number>,signal:AbortSignal):Promise<void>{
  const bytes=Buffer.from(JSON.stringify({version:1,directories:[...next].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,modified])=>({path,modified}))}));if(bytes.length>2*1024**2||bytes.length-this.#directoryBytes>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published directory quota exceeded');
  const temp=this.#path('.directories-'+randomUUID());let file:FileHandle|undefined,replaced=false,failure:unknown;
  try{signal.throwIfAborted();file=await open(temp,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);await file.writeFile(bytes);await file.sync();await file.close();file=undefined;signal.throwIfAborted();await rename(temp,this.#path('.directories.json'));replaced=true;await this.#root.sync();this.#storedBytes+=bytes.length-this.#directoryBytes;this.#directoryBytes=bytes.length;this.#directories=next;}
  catch(error){failure=error;if(replaced)this.#writeFault=error;throw new PublishedDirectoryCommitError(replaced?'replaced':'before-replace',error);}
  finally{try{await file?.close();if(!replaced){await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});await this.#root.sync();}}catch(cleanup){this.#writeFault=new AggregateError([...(failure?[failure]:[]),cleanup],'Directory cleanup failed');throw new PublishedDirectoryCommitError(replaced?'replaced':'before-replace',this.#writeFault);}}
 }
 directoryCatalog(path:string,signal:AbortSignal):Promise<{directories:readonly {path:string;modified:number}[];files:readonly {file:PublishedPrintFile;modified:number}[]}>{return this.#cachedNamespaceRead(async()=>{publishedPath(path,true);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');if(path&&!this.#directories.has(path))throw Object.assign(new Error('Published directory not found'),{code:'ENOENT'});return {directories:[...this.#directories].filter(([name])=>pathParent(name)===path).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,modified])=>({path,modified})),files:[...this.#records.values()].filter(entry=>pathParent(visibleFilePath(entry.record))===path).sort((a,b)=>visibleFilePath(a.record).localeCompare(visibleFilePath(b.record))).map(entry=>({file:entry.record,modified:entry.modified}))};},true,signal);}
 mutateDirectory(path:string,remove:boolean,signal:AbortSignal):Promise<PublishedDirectoryChange>{return this.#run(async()=>{
  publishedPath(path);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');const next=new Map(this.#directories),modified=Date.now()/1000;
  if(remove){if(!next.has(path))throw Object.assign(new Error('Published directory not found'),{code:'ENOENT'});if([...next.keys()].some(name=>name.startsWith(path+'/'))||[...this.#paths.keys()].some(name=>name.startsWith(path+'/')))throw Object.assign(new Error('Directory is not empty'),{code:'ENOTEMPTY'});next.delete(path);}
  else{if(next.has(path)||this.#paths.has(path))throw Object.assign(new Error('Directory already exists'),{code:'EEXIST'});if(pathParent(path)&&!next.has(pathParent(path)))throw Object.assign(new Error('Directory parent not found'),{code:'ENOENT'});if(next.size>=1024)throw new Error('Published directory limit exceeded');next.set(path,modified);}
  await this.#commitDirectories(next,signal);const event=Object.freeze({action:remove?'delete_dir' as const:'create_dir' as const,path,modified:remove?0:modified});for(const observer of this.#directoryObservers)try{observer(event);}catch{this.#observerFailures++;}return event;
 },true,signal);}
 resolvePath(path:string,signal:AbortSignal):Promise<string>{return this.#run(async()=>{publishedPath(path);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');const id=this.#paths.get(path);if(!id)throw Object.assign(new Error('Published file path not found'),{code:'ENOENT'});return id;},true,signal);}
 hasDirectory(path:string,signal:AbortSignal):Promise<boolean>{return this.#run(async()=>{publishedPath(path);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');return this.#directories.has(path);},true,signal);}
 /** Display only; cached naming does not authorize opening or printing bytes. */
 filename(id:string):string{this.#id(id);const file=this.#records.get(id)?.record;return file?visibleFilePath(file):id+'.gcode';}
 #moveTarget(source:string,destination:string):string{
  publishedPath(source);publishedPath(destination,true);
  const target=!destination||this.#directories.has(destination)?(destination?destination+'/':'')+pathBasename(source):destination;
  publishedPath(target);if(pathParent(target)&&!this.#directories.has(pathParent(target)))throw Object.assign(new Error('Move parent not found'),{code:'ENOENT'});
  if(target!==source&&(this.#paths.has(target)||this.#directories.has(target)))throw Object.assign(new Error('Move target already exists; replacement is not implemented'),{code:'EEXIST'});
  return target;
 }
 /** Authorization observes both resolved names. Commit checks the same receipt
  * and destination again after policy callbacks, behind the mutation barrier. */
 prepareFileMove(source:string,destination:string,signal:AbortSignal):Promise<PublishedFileMove>{return this.#run(async()=>{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published namespace requires recovery');publishedPath(source);
  if(this.#directories.has(source))throw Object.assign(new Error('Directory move is not implemented'),{code:'ENOTSUP'});
  const id=this.#paths.get(source),stored=id?this.#records.get(id):undefined;if(!stored)throw Object.assign(new Error('Move source not found'),{code:'ENOENT'});
  const before=await this.#record(stored.record.id);if(!this.#sameFile(before,stored.record))throw new PublishedFileChangedError('Move source changed outside store');
  const path=this.#moveTarget(source,destination),after=path===source?before:Object.freeze({...before,path,name:pathBasename(path)});
  const plan=Object.freeze({before,after,modified:stored.modified});this.#fileMoves.set(plan,destination);signal.throwIfAborted();return plan;
 },true,signal);}
 #sameFile(a:PublishedPrintFile,b:PublishedPrintFile):boolean{return a.id===b.id&&a.sha256===b.sha256&&a.size===b.size&&a.name===b.name&&visibleFilePath(a)===visibleFilePath(b);}
 /** One receipt is the namespace authority. Atomic replacement commits the
  * visible name without copying or replacing content or changing print IDs.
  * Recovery derives indexes from the old or new complete receipt. */
 moveFile(plan:PublishedFileMove,signal:AbortSignal):Promise<PublishedFileMove>{return this.#run(async()=>{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published writes require recovery');
  const destination=this.#fileMoves.get(plan);if(destination===undefined)throw new Error('Move plan belongs to another store');
  const id=plan.before.id,stored=this.#records.get(id);if(!stored||!this.#sameFile(stored.record,plan.before)||this.#paths.get(visibleFilePath(plan.before))!==id)throw new PublishedFileChangedError('Authorized move source changed');
  if(!this.#sameFile(await this.#record(id),plan.before))throw new PublishedFileChangedError('Move receipt changed outside store');
  if(this.#moveTarget(visibleFilePath(plan.before),destination)!==visibleFilePath(plan.after))throw new PublishedFileChangedError('Authorized move destination changed');
  if(visibleFilePath(plan.before)===visibleFilePath(plan.after)){signal.throwIfAborted();this.#changed('move_file',plan.after,stored.modified,plan.before);return plan;}
  const bytes=Buffer.from(JSON.stringify(plan.after));if(bytes.length>2048||bytes.length>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published move receipt quota exceeded');
  const temp=this.#path('.receipt-'+randomUUID());let file:FileHandle|undefined,replaced=false,failure:unknown;
  this.#reservedBytes+=bytes.length;
  try{
   signal.throwIfAborted();file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await file.writeFile(bytes);await file.utimes(stored.modified,stored.modified);await file.chmod(0o400);await file.sync();const modified=(await file.stat()).mtimeMs/1000;await file.close();file=undefined;signal.throwIfAborted();
   if(!this.#sameFile(await this.#record(id),plan.before))throw new PublishedFileChangedError('Move receipt changed before replacement');
   await rename(temp,this.#path(id+'.json'));replaced=true;
   // Cancellation after replacement cannot abandon the durability boundary.
   await this.#root.sync();this.#storedBytes+=bytes.length-stored.receiptBytes;this.#records.set(id,{...stored,record:plan.after,receiptBytes:bytes.length,modified});this.#paths.delete(visibleFilePath(plan.before));this.#paths.set(visibleFilePath(plan.after),id);
   const result=Object.freeze({...plan,modified});this.#changed('move_file',plan.after,modified,plan.before);return result;
  }catch(error){failure=error;if(replaced)this.#writeFault=error;throw new PublishedFileMoveCommitError(replaced?'replaced':'before-replace',error);}
  finally{
   try{await file?.close();if(!replaced){await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});await this.#root.sync();}}
   catch(cleanup){this.#writeFault=new AggregateError([...(failure?[failure]:[]),cleanup],'Move cleanup failed');throw new PublishedFileMoveCommitError(replaced?'replaced':'before-replace',this.#writeFault);}
   finally{this.#reservedBytes-=bytes.length;}
  }
 },true,signal);}
 #id(id:string):void{if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new Error('Invalid published file identifier');}
 #path(name:string):string{return `/proc/self/fd/${this.#root.fd}/${name}`;}
 /** Directory transactions retain the last fully durable cache until all
  * authorities commit. Cached listings can observe that coherent old/new view
  * without waiting for file IO; descriptor reads and mutations still queue. */
 #cachedNamespaceRead<T>(operation:()=>Promise<T>,exclusive:boolean,signal:AbortSignal):Promise<T>{
  if(!this.#cachedNamespaceWindow)return this.#run(operation,exclusive,signal);
  if(this.#closed)return Promise.reject(new Error('Published file store is closed'));
  if(signal.aborted)return Promise.reject(signal.reason);return Promise.resolve().then(operation);
 }
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
 async #record(id:string):Promise<PublishedPrintFile>{if(this.#writeFault)throw new Error('Published reads require recovery',{cause:this.#writeFault});return (await this.#receipt(id)).file;}
 async #receipt(id:string,capture=false):Promise<{file:PublishedPrintFile;source?:PublishedSourceIdentity}>{
  const file=await open(this.#path(id+'.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const stat=await file.stat({bigint:true});if(!stat.isFile()||stat.size>2048n)throw new Error('Invalid published file receipt');
   const buffer=Buffer.alloc(2049),{bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>2048)throw new Error('Published receipt exceeds limit');
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,bytesRead))) as PublishedPrintFile;
   if(value===null||typeof value!=='object'||Array.isArray(value)||value.version!==1||value.id!==id||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<0||value.size>this.#maxBytes||typeof value.name!=='string'||!value.name||value.name.length>256||/[\u0000-\u001f\u007f]/u.test(value.name))throw new Error('Invalid published file receipt');
   let source:PublishedSourceIdentity|undefined;
   if(capture){const after=await file.stat({bigint:true});if(stat.dev!==after.dev||stat.ino!==after.ino||stat.size!==BigInt(bytesRead)||stat.size!==after.size||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw new PublishedFileChangedError('Published receipt changed while reading its identity');source=Object.freeze({dev:stat.dev,ino:stat.ino,mtimeNs:stat.mtimeNs,ctimeNs:stat.ctimeNs});}
   if(value.path!==undefined)publishedPath(value.path);
   return {file:Object.freeze({version:1,id,sha256:value.sha256,size:value.size,name:value.name,...value.path===undefined?{}:{path:value.path}}),...source?{source}:{}};
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
 catalog(signal:AbortSignal):Promise<readonly {file:PublishedPrintFile;modified:number}[]>{return this.#cachedNamespaceRead(async()=>{
  signal.throwIfAborted();if(this.#writeFault)throw new Error('Published inventory requires recovery',{cause:this.#writeFault});
  return Object.freeze([...this.#records].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([,entry])=>Object.freeze({file:entry.record,modified:entry.modified})));
 },true,signal);}
 describe(id:string,signal:AbortSignal):Promise<{file:PublishedPrintFile;modified:number}>{return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();const stored=this.#records.get(id);if(!stored)throw Object.assign(new Error('Published file not found'),{code:'ENOENT'});
  const file=await this.#record(id);signal.throwIfAborted();if(file.sha256!==stored.record.sha256||file.name!==stored.record.name||file.size!==stored.record.size||visibleFilePath(file)!==visibleFilePath(stored.record))throw new Error('Published receipt changed outside store');return {file,modified:stored.modified};
 },true,signal);}
 /** Source identity is sampled with the receipt bytes from the same no-follow
  * descriptor behind the mutation barrier. Ordinary cached reads avoid the
  * extra fingerprint validation syscall. Callers still verify content bytes. */
 describeSource(id:string,signal:AbortSignal):Promise<{file:PublishedPrintFile;modified:number;source:PublishedSourceIdentity}>{return this.#run(async()=>{
  this.#id(id);signal.throwIfAborted();if(this.#writeFault)throw new Error('Published source requires recovery',{cause:this.#writeFault});
  const stored=this.#records.get(id);if(!stored)throw Object.assign(new Error('Published file not found'),{code:'ENOENT'});
  const result=await this.#receipt(id,true);signal.throwIfAborted();if(result.file.sha256!==stored.record.sha256||result.file.name!==stored.record.name||result.file.size!==stored.record.size||visibleFilePath(result.file)!==visibleFilePath(stored.record))throw new PublishedFileChangedError('Published receipt changed outside store');return {file:result.file,modified:stored.modified,source:result.source!};
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
 publish(id:string,name:string,source:FileHandle,signal:AbortSignal,path?:string):Promise<PublishedPrintFile>{return this.#run(async()=>{
  this.#id(id);if(this.#writeFault)throw new Error('Published writes require recovery',{cause:this.#writeFault});if(this.#records.has(id)||this.#publishing.has(id))throw Object.assign(new Error('Published identifier already exists'),{code:'EEXIST'});if(typeof name!=='string'||!name||name.length>256||/[\u0000-\u001f\u007f]/u.test(name))throw new Error('Invalid published file name');signal.throwIfAborted();
  const before=await source.stat({bigint:true});signal.throwIfAborted();if(!before.isFile()||before.size>BigInt(this.#maxBytes))throw new Error('Published source exceeds regular file limit');
  if(this.#records.has(id)||this.#publishing.has(id))throw Object.assign(new Error('Published identifier already exists'),{code:'EEXIST'});
  const visible=publishedPath(path??id+'.gcode');if(this.#paths.has(visible)||this.#publishingPaths.has(visible)||this.#directories.has(visible))throw Object.assign(new Error('Published path already exists'),{code:'EEXIST'});if(pathParent(visible)&&!this.#directories.has(pathParent(visible)))throw Object.assign(new Error('Published directory not found'),{code:'ENOENT'});
  let reserved=Number(before.size)+2048;if(this.#records.size+this.#publishing.size>=this.#maxFiles||reserved>this.#maxStorage-this.#storedBytes-this.#reservedBytes)throw new Error('Published storage quota exceeded');
  const temp=this.#path('.upload-'+randomUUID()),receiptTemp=this.#path('.receipt-'+randomUUID());let file:FileHandle|undefined,receipt:FileHandle|undefined,failure:unknown;
  this.#reservedBytes+=reserved;this.#publishing.add(id);this.#publishingPaths.add(visible);
  try{
   file=await open(temp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
   const buffer=Buffer.alloc(65536),hash=createHash('sha256');let position=0;
   while(position<Number(before.size)){
    signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,Number(before.size)-position),position);signal.throwIfAborted();if(!bytesRead)throw new Error('Published source truncated');hash.update(buffer.subarray(0,bytesRead));let written=0;
    while(written<bytesRead){signal.throwIfAborted();const result=await file.write(buffer,written,bytesRead-written,position+written);if(!result.bytesWritten)throw new Error('Published file write stalled');written+=result.bytesWritten;}position+=bytesRead;
   }
   const after=await source.stat({bigint:true});signal.throwIfAborted();if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Published source changed during copy');
   const record:PublishedPrintFile=Object.freeze({version:1,id,name,sha256:hash.digest('hex'),size:position,...path===undefined?{}:{path:visible}});if(Buffer.byteLength(JSON.stringify(record))>2048)throw new Error('Published receipt exceeds limit');
   await file.chmod(0o400);await file.sync();await file.close();file=undefined;signal.throwIfAborted();
   // Link is atomic and never replaces content already published under its digest.
   try{await link(temp,this.#path(record.sha256+'.gcode'));this.#storedBytes+=position;this.#reservedBytes-=position;reserved-=position;}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;await this.#verifyExisting(record,signal);}
   await this.#root.sync();signal.throwIfAborted();
   receipt=await open(receiptTemp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await receipt.writeFile(JSON.stringify(record));await receipt.chmod(0o400);await receipt.sync();const modified=(await receipt.stat()).mtimeMs/1000;await receipt.close();receipt=undefined;signal.throwIfAborted();
   await link(receiptTemp,this.#path(id+'.json'));const receiptBytes=Buffer.byteLength(JSON.stringify(record));this.#storedBytes+=receiptBytes;this.#reservedBytes-=receiptBytes;reserved-=receiptBytes;this.#records.set(id,{sha256:record.sha256,size:record.size,receiptBytes,record,modified});this.#paths.set(visible,id);this.#references.set(record.sha256,(this.#references.get(record.sha256)??0)+1);this.#publishing.delete(id);await this.#root.sync();this.#changed('create_file',record,modified);return record;
  }catch(error){failure=error;throw error;}finally{
   const closed=await Promise.allSettled([file?.close(),receipt?.close()]);
   const removed=await Promise.allSettled([unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;}),unlink(receiptTemp).catch(error=>{if(error.code!=='ENOENT')throw error;})]);
   const errors=[...closed,...removed].filter(result=>result.status==='rejected').map(result=>result.reason);
   this.#publishing.delete(id);this.#publishingPaths.delete(visible);
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
  if(record.sha256!==stored.sha256||record.size!==stored.size||record.name!==stored.record.name||visibleFilePath(record)!==visibleFilePath(stored.record)||!receipt.isFile()||receipt.size!==stored.receiptBytes)throw new Error('Published receipt changed outside store');
  if(expected&&(record.id!==expected.id||record.sha256!==expected.sha256||record.size!==expected.size||record.name!==expected.name||visibleFilePath(record)!==visibleFilePath(expected)))throw new PublishedFileChangedError('Authorized file changed before removal');
  const references=this.#references.get(stored.sha256);
  if(!references)throw new Error('Published content reference invariant failed');
  signal.throwIfAborted();let removed=false;
  try{
   await unlink(this.#path(id+'.json'));removed=true;this.#records.delete(id);this.#paths.delete(visibleFilePath(record));
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
  this.#closing=Promise.allSettled([...this.#pending]).then(()=>{this.#observers.clear();this.#directoryObservers.clear();return this.#root.close();});return this.#closing;
 }
}
