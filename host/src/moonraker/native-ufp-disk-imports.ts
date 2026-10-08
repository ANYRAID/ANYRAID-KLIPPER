import {open,mkdir,opendir,lstat,rename,unlink,rmdir,realpath,type FileHandle} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute,relative,sep} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {FileEvents,fileEventMask as mask} from './file-events.ts';
import {FileWriteLease} from './file-write-lease.ts';
import {NativePrintUploads} from './native-print-uploads.ts';
import {PublishedPrintFiles,type PublishedPrintFile} from '../storage/published-files.ts';
import {validatePublishedReceipt} from '../storage/published-receipt.ts';
import {nativeFilename} from './native-file-path.ts';
import {ApiError,type RpcContext} from './rpc.ts';
const privateName='.native-ufp-claims',idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const lock=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const path=(fd:FileHandle,name='.')=>`/proc/self/fd/${fd.fd}/${name}`;
const directoryFlags=constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW;
const sourceFlags=constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK;
async function retire(actions:(()=>Promise<unknown>|undefined)[],primary?:unknown){const errors:unknown[]=[];for(const action of actions)try{await action();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(primary===undefined?errors:[primary,...errors],'Disk import retirement failed');}
interface Intent {version:1;id:string;path:string;source:{dev:string;ino:string};archive:{size:number;sha256:string};}
export interface NativeUfpDiskImportOptions {
 root:string;
 /** Current process policy, supplied by its owner. No implicit principal. */
 context(signal:AbortSignal):Promise<RpcContext>|RpcContext;
 maxClaims?:number;maxClaimBytes?:number;
 /** Trusted lifecycle observer. A failure preserves the durable transaction. */
 checkpoint?(phase:'intent'|'claimed'|'published'|'decided'|'unlinked',id:string):Promise<void>|void;
}
/** One inbox and private claim ledger per process, using the existing file
 * publication owner. Watches offer discovery; a kernel lease proves readiness. */
export class NativeUfpDiskImports {
 readonly #root:FileHandle;readonly #claims:FileHandle;readonly #uploads:NativePrintUploads;readonly #files:PublishedPrintFiles;readonly #options:NativeUfpDiskImportOptions;
 readonly #abort=new AbortController();readonly #directories=new Map<number,{fd:FileHandle;relative:string}>();readonly #pending=new Set<string>();readonly #maxClaims:number;readonly #maxBytes:number;
 #watcher:FileEvents;#running:Promise<void>|undefined;#rescan=true;#closed=false;#closing:Promise<void>|undefined;#fault:unknown;#blocked:'claims'|'bytes'|undefined;#count=0;#bytes=0;#completed=0;#rejected=0;#busy=0;
 private constructor(root:FileHandle,claims:FileHandle,uploads:NativePrintUploads,files:PublishedPrintFiles,options:NativeUfpDiskImportOptions){
  this.#root=root;this.#claims=claims;this.#uploads=uploads;this.#files=files;this.#options=options;this.#maxClaims=options.maxClaims??32;this.#maxBytes=options.maxClaimBytes??256*1024**2;
  this.#watcher=this.#newWatcher();
 }
 #newWatcher(){return new FileEvents(events=>{
  for(const event of events){const parent=this.#directories.get(event.watch);if(!parent)continue;
   if(event.mask&(mask.moveSelf|mask.deleteSelf|mask.unmount)){this.#rescan=true;continue;}
   if(event.mask&mask.directory){if(event.name!==privateName&&event.mask&(mask.create|mask.delete|mask.movedFrom|mask.movedTo))this.#rescan=true;continue;}
   if(event.mask&(mask.closeWrite|mask.movedTo)&&/\.ufp$/i.test(event.name)){if(this.#pending.size>=256)this.#rescan=true;else this.#pending.add((parent.relative?parent.relative+'/':'')+event.name);}
  }this.#pump();
 },cause=>this.#fail(cause));}
 static async open(uploads:NativePrintUploads,files:PublishedPrintFiles,options:NativeUfpDiskImportOptions):Promise<NativeUfpDiskImports>{
  if(!(uploads instanceof NativePrintUploads)||!(files instanceof PublishedPrintFiles)||!uploads.usesFiles(files)||uploads.status.closed||files.status.closed||!options||typeof options.context!=='function'||!isAbsolute(options.root)||/[\0\r\n]/u.test(options.root))throw new TypeError('Invalid native disk import owner');
  const count=options.maxClaims??32,bytes=options.maxClaimBytes??256*1024**2;if(!Number.isSafeInteger(count)||count<1||count>128||!Number.isSafeInteger(bytes)||bytes<1||bytes>1024**3)throw new RangeError('Invalid disk claim capacity');
  await mkdir(options.root,{recursive:true,mode:0o700});const root=await open(options.root,directoryFlags);let claims:FileHandle|undefined,owner:NativeUfpDiskImports|undefined;
  try{const info=await root.stat();if(info.uid!==process.getuid!()||(info.mode&0o077))throw new Error('Disk inbox must be private and service-owned');
   // The inbox must not share the immutable published content namespace.
   const published=await open(await files.directoryPath(new AbortController().signal),directoryFlags);try{const inboxPath=await realpath(path(root)),publishedPath=await realpath(path(published)),overlaps=(a:string,b:string)=>{const tail=relative(a,b);return tail===''||!isAbsolute(tail)&&tail!=='..'&&!tail.startsWith('..'+sep);};if(overlaps(inboxPath,publishedPath)||overlaps(publishedPath,inboxPath))throw new Error('Disk inbox and published file store must be separate');}finally{await published.close();}
   await mkdir(path(root,privateName),{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});claims=await open(path(root,privateName),directoryFlags);const stat=await claims.stat();if(stat.uid!==process.getuid!()||(stat.mode&0o077))throw new Error('Claim directory must be private and service-owned');lock.lockDirectory(claims.fd);await root.sync();
   owner=new NativeUfpDiskImports(root,claims,uploads,files,{...options});await owner.#recover();owner.#pump();return owner;
  }catch(error){await retire(owner?[()=>owner!.close()]:[()=>claims?.close(),()=>root.close()],error);throw error;}
 }
 get status(){return {closed:this.#closed,pending:this.#pending.size,active:!!this.#running,claims:this.#count,claimBytes:this.#bytes,completed:this.#completed,rejected:this.#rejected,busy:this.#busy,blocked:this.#blocked,fault:this.#fault};}
 async idle():Promise<void>{while(this.#running)await this.#running;if(this.#fault!==undefined)throw this.#fault;}
 #fail(error:unknown){if(this.#fault!==undefined)return;this.#fault=error;this.#abort.abort(error);void this.#watcher.close();}
 #pump(){if(this.#closed||this.#fault!==undefined||this.#running)return;
  const task=(async()=>{while(!this.#closed&&!this.#abort.signal.aborted){if(this.#rescan)await this.#scan();const next=this.#pending.values().next();if(next.done)break;this.#pending.delete(next.value);await this.#admit(next.value);}})();this.#running=task;
  void task.catch(error=>this.#fail(error)).finally(()=>{if(this.#running===task)this.#running=undefined;if(!this.#closed&&(this.#rescan||this.#pending.size))this.#pump();});
 }
 async #scan(){
  this.#rescan=false;await this.#watcher.close();for(const {fd} of this.#directories.values())if(fd!==this.#root)await fd.close();this.#directories.clear();this.#watcher=this.#newWatcher();let entries=0;
  const visit=async(fd:FileHandle,relative:string):Promise<void>=>{
   this.#abort.signal.throwIfAborted();if(this.#directories.size>=1024)throw new Error('Inbox directory capacity exceeded');const watch=this.#watcher.add(fd);this.#directories.set(watch,{fd,relative});
   const iterator=await opendir(path(fd),{bufferSize:32});for await(const entry of iterator){if(++entries>16384)throw new Error('Inbox scan capacity exceeded');if(entry.name===privateName&&!relative)continue;
    const name=nativeFilename((relative?relative+'/':'')+entry.name);if(entry.isSymbolicLink())continue;
    if(entry.isDirectory()){const child=await open(path(fd,entry.name),directoryFlags);try{await visit(child,name);}catch(error){if(![...this.#directories.values()].some(item=>item.fd===child))await child.close();throw error;}}
    // Drain a bounded batch before continuing this same directory iterator.
    // Busy/denied inputs do not prevent discovery beyond the first 256 files.
    else if(entry.isFile()&&/\.ufp$/i.test(entry.name)){if(this.#pending.size>=256)await this.#drainPending();this.#pending.add(name);}
   }
  };await visit(this.#root,'');
 }
 async #drainPending(){while(this.#pending.size){this.#abort.signal.throwIfAborted();const name=this.#pending.values().next().value!;this.#pending.delete(name);await this.#admit(name);}}
 async #parent(relative:string):Promise<{fd:FileHandle;name:string;owned:boolean}>{
  const parts=nativeFilename(relative).split('/');let fd=this.#root;try{for(const part of parts.slice(0,-1)){const next=await open(path(fd,part),directoryFlags);if(fd!==this.#root)await fd.close();fd=next;}return {fd,name:parts.at(-1)!,owned:fd!==this.#root};}catch(error){if(fd!==this.#root)await fd.close();throw error;}
 }
 async #digest(source:FileHandle,signal:AbortSignal){const before=await source.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(this.#uploads.status.maxFileBytes))throw new ApiError(413,'Invalid inbox archive size');const buffer=Buffer.allocUnsafe(65536),digest=createHash('sha256');let at=0;while(at<Number(before.size)){signal.throwIfAborted();const {bytesRead}=await source.read(buffer,0,Math.min(buffer.length,Number(before.size)-at),at);if(!bytesRead)throw new ApiError(409,'Inbox archive changed');digest.update(buffer.subarray(0,bytesRead));at+=bytesRead;}return {size:Number(before.size),sha256:digest.digest('hex'),stat:before};}
 async #json(fd:FileHandle,name:string,value:unknown){const temporary=path(fd,name+'.tmp'),file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{await file.writeFile(JSON.stringify(value));await file.sync();}finally{await file.close();}await rename(temporary,path(fd,name));await fd.sync();}
 async #read(fd:FileHandle,name:string):Promise<any>{const file=await open(path(fd,name),sourceFlags);try{const stat=await file.stat({bigint:true});if(!stat.isFile()||stat.size<1n||stat.size>4096n)throw new Error('Invalid claim record');const bytes=Buffer.alloc(Number(stat.size)+1);let at=0;while(at<bytes.length){const {bytesRead}=await file.read(bytes,at,bytes.length-at,at);if(!bytesRead)break;at+=bytesRead;}const after=await file.stat({bigint:true});if(at!==Number(stat.size)||stat.size!==after.size||stat.mtimeNs!==after.mtimeNs||stat.ctimeNs!==after.ctimeNs)throw new Error('Claim record changed');return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,at)));}finally{await file.close();}}
 #intent(value:any,id:string):Intent{
  if(!value||value.version!==1||value.id!==id||Object.keys(value).sort().join(',')!=='archive,id,path,source,version'||typeof value.path!=='string'||!value.source||!value.archive||Object.keys(value.source).sort().join(',')!=='dev,ino'||Object.keys(value.archive).sort().join(',')!=='sha256,size'||typeof value.source.dev!=='string'||typeof value.source.ino!=='string'||!/^\d+$/.test(value.source.dev)||!/^\d+$/.test(value.source.ino)||!Number.isSafeInteger(value.archive.size)||value.archive.size<1||value.archive.size>this.#uploads.status.maxFileBytes||typeof value.archive.sha256!=='string'||! /^[a-f0-9]{64}$/.test(value.archive.sha256))throw new Error('Invalid durable claim intent');
  nativeFilename(value.path);if(!/\.ufp$/i.test(value.path)||value.path.split('/')[0]===privateName)throw new Error('Invalid claim path');return value;
 }
 async #admit(relative:string){
  if(this.#count>=this.#maxClaims){this.#blocked='claims';return;}let parent:{fd:FileHandle;name:string;owned:boolean}|undefined;
  let source:FileHandle|undefined,lease:FileWriteLease|undefined,claim:FileHandle|undefined,intent:Intent|undefined,failure:unknown;
  try{parent=await this.#parent(relative);source=await open(path(parent.fd,parent.name),sourceFlags);lease=await FileWriteLease.acquire(source,this.#abort.signal);if(!lease){this.#busy++;return;}
   const signal=AbortSignal.any([this.#abort.signal,lease.signal]),archive=await this.#digest(source,signal);if(this.#bytes+archive.size>this.#maxBytes){this.#blocked='bytes';return;}this.#blocked=undefined;
   const context=await this.#options.context(signal);if(!context||typeof context.authorize!=='function'||context.signal.aborted)throw new ApiError(403,'Disk import policy unavailable');await context.authorize('server.files.upload',{root:'gcodes',path:relative,filename:relative.split('/').at(-1)!,size:archive.size,sha256:archive.sha256});signal.throwIfAborted();
   const id=randomUUID();await mkdir(path(this.#claims,id),{mode:0o700});claim=await open(path(this.#claims,id),directoryFlags);await this.#claims.sync();intent={version:1,id,path:relative,source:{dev:String(archive.stat.dev),ino:String(archive.stat.ino)},archive:{size:archive.size,sha256:archive.sha256}};await this.#json(claim,'intent.json',intent);this.#count++;this.#bytes+=archive.size;await this.#options.checkpoint?.('intent',id);
   await lease.check();await rename(path(parent.fd,parent.name),path(claim,'source.ufp'));await parent.fd.sync();await claim.sync();await this.#assertSource(claim,source,intent);await this.#options.checkpoint?.('claimed',id);
   await this.#finish(claim,source,lease,intent,context);
  }catch(error){try{if(error instanceof ApiError&&[400,403,409,413,422].includes(error.status)){if(intent&&claim)await this.#json(claim,'rejected.json',{version:1,id:intent.id,status:error.status});this.#rejected++;}else if(!intent&&(error as NodeJS.ErrnoException)?.code==='ENOENT')return;else throw error;}catch(cause){failure=cause;throw cause;}}
  finally{await retire([()=>lease?.close(),()=>source?.close(),()=>claim?.close(),()=>parent?.owned?parent.fd.close():undefined],failure);}
 }
 async #assertSource(claim:FileHandle,source:FileHandle,intent:Intent){const actual=await lstat(path(claim,'source.ufp'),{bigint:true}),opened=await source.stat({bigint:true});if(!actual.isFile()||String(actual.dev)!==intent.source.dev||String(actual.ino)!==intent.source.ino||actual.dev!==opened.dev||actual.ino!==opened.ino)throw new Error('Claimed source identity changed');}
 async #finish(claim:FileHandle,source:FileHandle,lease:FileWriteLease,intent:Intent,context:RpcContext,decision?:PublishedPrintFile){
  const signal=AbortSignal.any([this.#abort.signal,lease.signal,context.signal]);await this.#assertSource(claim,source,intent);const archive=await this.#digest(source,signal);if(archive.size!==intent.archive.size||archive.sha256!==intent.archive.sha256)throw new ApiError(409,'Durable claim archive changed');
  await lease.check();if(!decision){const result=await this.#uploads.importUfp(source,intent.path,{...context,signal},intent.id) as any;await this.#options.checkpoint?.('published',intent.id);decision=validatePublishedReceipt(result.file,this.#uploads.status.maxFileBytes);await this.#json(claim,'decision.json',{version:1,intent,file:decision});await this.#options.checkpoint?.('decided',intent.id);}
  await this.#authorizeCleanup(intent,decision,signal);await this.#files.verifyReceipt(decision,signal);await lease.check();await this.#assertSource(claim,source,intent);signal.throwIfAborted();await unlink(path(claim,'source.ufp'));await claim.sync();await this.#options.checkpoint?.('unlinked',intent.id);await this.#removeClaim(claim,intent);this.#completed++;
 }
 async #authorizeCleanup(intent:Intent,decision:PublishedPrintFile,signal:AbortSignal){const visible=intent.path.replace(/\.ufp$/i,'.gcode');if(decision.id!==intent.id||decision.path!==visible||decision.name!==visible.split('/').at(-1))throw new Error('Claim decision identity mismatch');const context=await this.#options.context(signal);if(!context||typeof context.authorize!=='function')throw new ApiError(403,'Disk cleanup policy unavailable');context.signal.throwIfAborted();await context.authorize('server.files.upload',{root:'gcodes',path:intent.path,file_id:intent.id,size:intent.archive.size,sha256:intent.archive.sha256});await context.authorize('server.files.upload',{root:'gcodes',path:visible,filename:decision.name,file_id:intent.id,size:decision.size,sha256:decision.sha256});context.signal.throwIfAborted();signal.throwIfAborted();}
 async #removeClaim(claim:FileHandle,intent:Intent){for(const name of ['intent.json','decision.json']){await unlink(path(claim,name)).catch(error=>{if(error.code!=='ENOENT')throw error;});await claim.sync();}await rmdir(path(this.#claims,intent.id));await this.#claims.sync();this.#count--;this.#bytes-=intent.archive.size;}
 async #recover(){
  const iterator=await opendir(path(this.#claims),{bufferSize:16});for await(const entry of iterator){if(!entry.isDirectory()||!idPattern.test(entry.name)||this.#count>=this.#maxClaims)throw new Error('Unknown or excessive claim entry');const claim=await open(path(this.#claims,entry.name),directoryFlags);let source:FileHandle|undefined,lease:FileWriteLease|undefined,failure:unknown;
   try{const stat=await claim.stat();if(stat.uid!==process.getuid!()||(stat.mode&0o077))throw new Error('Recovered claim must be private and service-owned');const names:string[]=[];for await(const child of await opendir(path(claim),{bufferSize:8})){if(names.length>=8||!child.isFile()||!['intent.json','source.ufp','decision.json','rejected.json','intent.json.tmp','decision.json.tmp','rejected.json.tmp'].includes(child.name))throw new Error('Unknown claim content');names.push(child.name);}
    if(!names.length){await rmdir(path(this.#claims,entry.name));await this.#claims.sync();continue;}
    if(names.length===1&&names[0]==='intent.json.tmp'){const temporary=await open(path(claim,names[0]),sourceFlags);try{const stat=await temporary.stat();if(!stat.isFile()||stat.size>4096)throw new Error('Invalid incomplete intent');}finally{await temporary.close();}await unlink(path(claim,names[0]));await claim.sync();await rmdir(path(this.#claims,entry.name));await this.#claims.sync();continue;}
    const saved=names.includes('decision.json')?await this.#read(claim,'decision.json'):undefined;
    if(saved&&(saved.version!==1||Object.keys(saved).sort().join(',')!=='file,intent,version'))throw new Error('Invalid claim decision');
    if(!names.includes('intent.json')&&!saved)throw new Error('Claim intent missing');const intent=this.#intent(names.includes('intent.json')?await this.#read(claim,'intent.json'):saved.intent,entry.name);if(saved&&JSON.stringify(this.#intent(saved.intent,entry.name))!==JSON.stringify(intent))throw new Error('Claim decision intent mismatch');this.#count++;this.#bytes+=intent.archive.size;if(this.#bytes>this.#maxBytes)throw new Error('Recovered claims exceed capacity');
    if(names.includes('rejected.json')){const rejected=await this.#read(claim,'rejected.json');if(rejected.version!==1||rejected.id!==intent.id||![400,403,409,413,422].includes(rejected.status))throw new Error('Invalid rejected claim');this.#rejected++;continue;}
    const decision=saved?validatePublishedReceipt(saved.file,this.#uploads.status.maxFileBytes):undefined;
    for(const name of names.filter(name=>name.endsWith('.tmp')))await unlink(path(claim,name));await claim.sync();
    if(!names.includes('source.ufp')){if(decision){await this.#authorizeCleanup(intent,decision,this.#abort.signal);await this.#files.verifyReceipt(decision,this.#abort.signal);await this.#removeClaim(claim,intent);this.#completed++;continue;}
     const parent=await this.#parent(intent.path);try{source=await open(path(parent.fd,parent.name),sourceFlags);const stat=await source.stat({bigint:true});if(String(stat.dev)!==intent.source.dev||String(stat.ino)!==intent.source.ino)throw new Error('Unclaimed inbox identity changed');lease=await FileWriteLease.acquire(source,this.#abort.signal);if(!lease)throw new Error('Prepared claim still has a writer');await rename(path(parent.fd,parent.name),path(claim,'source.ufp'));await parent.fd.sync();await claim.sync();}finally{if(parent.owned)await parent.fd.close();}
    }else source=await open(path(claim,'source.ufp'),sourceFlags);
    lease??=await FileWriteLease.acquire(source!,this.#abort.signal);if(!lease)throw new Error('Claim archive still has a writer');const signal=AbortSignal.any([this.#abort.signal,lease.signal]),context=await this.#options.context(signal);await this.#finish(claim,source!,lease,intent,context,decision);
   }catch(error){failure=error;throw error;}finally{await retire([()=>lease?.close(),()=>source?.close(),()=>claim.close()],failure);}
  }
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#abort.abort(new Error('Disk import owner closed'));return this.#closing=(async()=>{const errors:unknown[]=[];try{await this.#watcher.close();}catch(error){errors.push(error);}await this.#running?.catch(()=>{});const directories=[...this.#directories.values()].filter(({fd})=>fd!==this.#root);this.#directories.clear();await retire([...errors.map(error=>async()=>{throw error;}),...directories.map(({fd})=>()=>fd.close()),()=>this.#claims.close(),()=>this.#root.close()]);})();}
}
