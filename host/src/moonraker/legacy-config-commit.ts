import {constants} from 'node:fs';
import {open,lstat,realpath,rename,link,unlink,type FileHandle} from 'node:fs/promises';
import {dirname,basename,isAbsolute,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {ApiError,type Json} from './rpc.ts';
import type {LegacyConfigEdit} from './legacy-config-plan.ts';
type FilePhase='pending'|'started'|'confirmed';
interface Entry {filename:string;beforeSha256:string;afterSha256:string;phase:FilePhase;backup:string|null;}
interface Record {schema:1;candidateSha256:string;phase:'planned'|'committing'|'confirmed';files:Entry[];}
const lock=createRequire(import.meta.url)('../../build/sealed-file.node') as {lockDirectory(fd:number):void};
const digest=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/u.test(value);
const path=(value:unknown):value is string=>typeof value==='string'&&isAbsolute(value)&&resolve(value)===value&&value!=='/'&&value.isWellFormed()&&!/[\0\r\n]/u.test(value)&&Buffer.byteLength(value)<=4096;
const fields=(value:object,keys:string[])=>Object.keys(value).length===keys.length&&Object.keys(value).every(k=>keys.includes(k));
async function bytes(fd:FileHandle,max:number,signal:AbortSignal):Promise<Buffer>{
 const before=await fd.stat({bigint:true});if(!before.isFile()||before.nlink!==1n||before.uid!==BigInt(process.getuid!())||before.size>BigInt(max))throw new ApiError(409,'Installation configuration file identity requires reconciliation');
 const result=Buffer.alloc(max+1);let at=0;try{while(at<result.length){signal.throwIfAborted();const r=await fd.read(result,at,result.length-at,null);if(!r.bytesRead)break;at+=r.bytesRead;}if(at>max)throw new ApiError(413,'Installation configuration input exceeded capacity');const after=await fd.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new ApiError(409,'Installation configuration changed during confirmation');return Buffer.from(result.subarray(0,at));}finally{result.fill(0);}
}
async function fileHash(filename:string,signal:AbortSignal):Promise<string>{
 if(await realpath(filename)!==filename)throw new ApiError(409,'Installation configuration physical target changed');
 const parent=await open(dirname(filename),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW),file=await open('/proc/self/fd/'+parent.fd+'/'+basename(filename),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK).catch(async error=>{await parent.close();throw error;});
 try{const content=await bytes(file,8*1024*1024,signal);try{return digest(content);}finally{content.fill(0);}}finally{try{await file.close();}finally{await parent.close();}}
}
/** Durable individual-save decisions, not a filesystem-wide atomic batch.
 * An interrupted/mixed batch is deliberately blocked for reconciliation. This
 * owner never replays a write from a journal or overwrites later user edits. */
export class LegacyConfigCommitOwner {
 readonly #path:string;#parent:FileHandle|undefined;#record:Record|undefined;#closing:Promise<void>|undefined;#active:Promise<unknown>|undefined;#inspected=false;readonly #pending=new Set<Promise<unknown>>();
 constructor(recoveryPath:string){if(!path(recoveryPath))throw new TypeError('Invalid installation configuration recovery path');this.#path=recoveryPath;}
 get phase(){return this.#record?.phase;}
 async #directory(missing=false):Promise<FileHandle|undefined>{
  if(this.#parent)return this.#parent;
  const directory=dirname(this.#path);if(await realpath(directory).catch(error=>{if(missing&&(error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;})===undefined)return;
  if(await realpath(directory)!==directory)throw new ApiError(409,'Installation recovery directory must be physical');const parent=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{const info=await parent.stat();if(info.uid!==process.getuid!()||(info.mode&0o077)!==0)throw new ApiError(409,'Installation recovery requires a private service-owned directory');lock.lockDirectory(parent.fd);this.#parent=parent;return parent;}catch(error){await parent.close();throw error;}
 }
 async #identity(){const held=await this.#parent!.stat(),current=await lstat(dirname(this.#path));if(!current.isDirectory()||current.isSymbolicLink()||held.dev!==current.dev||held.ino!==current.ino)throw new ApiError(409,'Installation recovery directory changed');}
 #track<T>(run:()=>Promise<T>):Promise<T>{if(this.#closing)return Promise.reject(new ApiError(503,'Installation configuration journal closed'));const task=Promise.resolve().then(run);this.#pending.add(task);return task.finally(()=>{this.#pending.delete(task);});}
 inspect(approvedFiles:readonly string[],candidateSha256:string,signal:AbortSignal):Promise<'absent'|'planned'|'confirmed'>{return this.#track(()=>this.#inspect(approvedFiles,candidateSha256,signal));}
 async #inspect(approvedFiles:readonly string[],candidateSha256:string,signal:AbortSignal):Promise<'absent'|'planned'|'confirmed'>{
  this.#inspected=false;
  if(!sha(candidateSha256)||!Array.isArray(approvedFiles)||approvedFiles.length>256||approvedFiles.some(p=>!path(p)))throw new TypeError('Invalid installation recovery approval');
  const parent=await this.#directory(true);if(!parent){this.#inspected=true;return 'absent';}await this.#identity();let file:FileHandle;
  try{file=await open('/proc/self/fd/'+parent.fd+'/'+basename(this.#path),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){this.#inspected=true;return 'absent';}throw error;}
  let value:unknown;try{const info=await file.stat();if((info.mode&0o077)!==0)throw new ApiError(409,'Installation configuration journal permissions changed');const content=await bytes(file,1024*1024,signal);try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(content));}finally{content.fill(0);}}finally{await file.close();}
  if(!value||typeof value!=='object'||Array.isArray(value)||!fields(value,['schema','candidateSha256','phase','files']))throw new ApiError(409,'Installation configuration journal schema requires reconciliation');const row=value as Record;
  if(row.schema!==1||row.candidateSha256!==candidateSha256||!['planned','committing','confirmed'].includes(row.phase)||!Array.isArray(row.files)||row.files.length>256||new Set(row.files.map(f=>f?.filename)).size!==row.files.length)throw new ApiError(409,'Installation configuration journal identity requires reconciliation');
  for(const entry of row.files){if(!entry||typeof entry!=='object'||Array.isArray(entry)||!fields(entry,['filename','beforeSha256','afterSha256','phase','backup'])||!path(entry.filename)||!approvedFiles.includes(entry.filename)||!sha(entry.beforeSha256)||!sha(entry.afterSha256)||!['pending','started','confirmed'].includes(entry.phase)||entry.backup!==null&&(typeof entry.backup!=='string'||!/^\.[^/\\\0]+\.save-backup-[a-f0-9-]{36}$/u.test(entry.backup)))throw new ApiError(409,'Installation configuration journal target requires reconciliation');}
  this.#record=row;
  if(row.phase==='committing'||row.files.some(f=>f.phase!==(row.phase==='confirmed'?'confirmed':'pending')))throw new ApiError(409,'Partial or unknown installation configuration requires reconciliation');
  for(const entry of row.files)if(await fileHash(entry.filename,signal)!==(row.phase==='confirmed'?entry.afterSha256:entry.beforeSha256))throw new ApiError(409,'Installation configuration was edited after its recorded decision');await this.#identity();this.#inspected=true;return row.phase;
 }
 async #write(row:Record,signal:AbortSignal,initial=false){
  signal.throwIfAborted();const parent=await this.#directory();if(!parent)throw new ApiError(409,'Installation recovery directory missing');await this.#identity();const data=Buffer.from(JSON.stringify(row)+'\n');if(data.length>1024*1024)throw new ApiError(413,'Installation configuration journal exceeded capacity');const base='/proc/self/fd/'+parent.fd+'/',temporary=base+'.config-batch-'+randomUUID(),file=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);let published=false;
  try{await file.writeFile(data);await file.sync();await file.close();signal.throwIfAborted();await this.#identity();if(initial){await link(temporary,base+basename(this.#path));published=true;await parent.sync();await unlink(temporary);}else{await rename(temporary,base+basename(this.#path));published=true;}await parent.sync();this.#record=structuredClone(row);await this.#identity();}finally{data.fill(0);await file.close().catch(()=>{});if(!published)await unlink(temporary).catch(()=>{});}
 }
 /** Called inside the already admitted writer lease, before root/config effects. */
 plan(edits:readonly LegacyConfigEdit[],candidateSha256:string,signal:AbortSignal):Promise<void>{return this.#track(()=>this.#plan(edits,candidateSha256,signal));}
 async #plan(edits:readonly LegacyConfigEdit[],candidateSha256:string,signal:AbortSignal):Promise<void>{
  if(!this.#inspected)throw new ApiError(409,'Configuration plan requires a successful recovery inspection');
  if(!sha(candidateSha256)||edits.length>256||new Set(edits.map(e=>e.filename)).size!==edits.length)throw new TypeError('Invalid configuration commit plan');const row:Record={schema:1,candidateSha256,phase:'planned',files:edits.map(edit=>{if(!path(edit.filename)||!sha(edit.beforeSha256)||!sha(edit.afterSha256)||digest(edit.before)!==edit.beforeSha256||digest(edit.after)!==edit.afterSha256)throw new TypeError('Invalid configuration commit identity');return {filename:edit.filename,beforeSha256:edit.beforeSha256,afterSha256:edit.afterSha256,phase:'pending',backup:null};})};
  if(this.#record&&JSON.stringify(this.#record)!==JSON.stringify(row))throw new ApiError(409,'Existing configuration decision cannot be replaced');await this.#write(row,signal,this.#record===undefined);
 }
 /** Every started save has a durable unknown decision before commit is called.
  * Confirmed previous saves survive a later authorization/save failure. */
 commitAll(commit:(index:number)=>Promise<Json>,signal:AbortSignal):Promise<void>{
  if(this.#active)return Promise.reject(new ApiError(409,'Configuration batch already committing'));if(!this.#record||this.#record.phase!=='planned')return Promise.reject(new ApiError(409,'Configuration batch not planned'));
  const task=this.#track(async()=>{const row=structuredClone(this.#record!);row.phase='committing';await this.#write(row,signal);for(let i=0;i<row.files.length;i++){const entry=row.files[i]!;entry.phase='started';await this.#write(row,signal);const result=await commit(i);if(!result||typeof result!=='object'||Array.isArray(result)||result.phase!=='replaced'||result.fileAndDirectorySynced!==true||result.sha256!==entry.afterSha256||typeof result.backup!=='string'||await fileHash(entry.filename,signal)!==entry.afterSha256)throw new ApiError(409,'Configuration replacement confirmation requires reconciliation');entry.backup=basename(result.backup);entry.phase='confirmed';await this.#write(row,signal);}row.phase='confirmed';await this.#write(row,signal);});this.#active=task;return task.finally(()=>{this.#active=undefined;});
 }
 close():Promise<void>{return this.#closing??=(async()=>{const results=await Promise.allSettled([...this.#pending]);try{await this.#parent?.close();}catch(error){results.push({status:'rejected',reason:error});}finally{this.#parent=undefined;}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Installation configuration journal close failed');})();}
}
