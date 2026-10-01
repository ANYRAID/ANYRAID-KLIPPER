import {constants,type BigIntStats} from 'node:fs';
import {open,lstat,unlink,opendir,type FileHandle} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ApiError} from '../moonraker/rpc.ts';
export const configBackupCapacity=16;
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isConfigBackup(source:string,name:string):boolean{const prefix='.'+source+'.save-backup-';return name.startsWith(prefix)&&uuid.test(name.slice(prefix.length));}
const version=(s:BigIntStats)=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.gid,s.nlink].map(String).join(':');
export function managedConfigBackup(s:BigIntStats):boolean{return s.isFile()&&s.nlink===1n&&(s.mode&0o7777n)===0o600n&&s.uid===BigInt(process.getuid!());}
/** Borrowed pinned parent, fixed entry bound, no following links. Cooperative
 * writer lock is required for mutation callers; metadata reads are snapshots. */
export async function scanConfigBackups(parent:FileHandle,source:string,signal:AbortSignal){
 const directory='/proc/self/fd/'+parent.fd,entries=await opendir(directory),backups:{name:string;stat:BigIntStats}[]=[];let scanned=0,total=0;
 try{for(;;){signal.throwIfAborted();const item=await entries.read();if(!item)break;if(++scanned>4096)throw new ApiError(413,'Configuration directory entry limit exceeded');if(!item.name.startsWith('.'+source+'.save-backup-'))continue;total++;
  if(!isConfigBackup(source,item.name))continue;let stat:BigIntStats;try{stat=await lstat(directory+'/'+item.name,{bigint:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}if(managedConfigBackup(stat))backups.push({name:item.name,stat});
 }}finally{await entries.close();}
 backups.sort((a,b)=>a.stat.mtimeNs<b.stat.mtimeNs?-1:a.stat.mtimeNs>b.stat.mtimeNs?1:a.name.localeCompare(b.name));return {total,backups};
}
export async function removeScannedConfigBackup(parent:FileHandle,backup:{name:string;stat:BigIntStats},signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const path='/proc/self/fd/'+parent.fd+'/'+backup.name,current=await lstat(path,{bigint:true});if(version(current)!==version(backup.stat)||!managedConfigBackup(current))throw new ApiError(409,'Backup changed before removal');signal.throwIfAborted();await unlink(path);await parent.sync();
}
/** Delete exactly the digest previewed by the caller; retain a recovery copy.
 * A successful unlink followed by failed directory sync is explicitly reported
 * as uncertain. Never report success or automatically retry that phase. */
export async function deleteNativeConfigBackup(parent:FileHandle,source:string,backup:string,expected:string,max:number,signal:AbortSignal){
 if(!isConfigBackup(source,backup)||!/^[a-f0-9]{64}$/.test(expected))throw new ApiError(400,'Invalid config backup identity');
 const directory='/proc/self/fd/'+parent.fd,lockPath=directory+'/.'+source+'.save.lock';let lock:FileHandle|undefined,lockVersion:string|undefined,removed=false,failure:unknown;
 try{
  signal.throwIfAborted();try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError(409,'Configuration writer lock is held');throw e;}lockVersion=version(await lock.stat({bigint:true}));
  const scan=await scanConfigBackups(parent,source,signal),selected=scan.backups.find(b=>b.name===backup);if(!selected)throw new ApiError(404,'Managed configuration backup unavailable');if(scan.backups.length<=1)throw new ApiError(409,'Keep at least one configuration recovery copy');
  const path=directory+'/'+backup,file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let before:BigIntStats;
  try{before=await file.stat({bigint:true});if(version(before)!==version(selected.stat)||before.size>BigInt(max))throw new ApiError(409,'Backup identity or size changed');const hash=createHash('sha256'),buffer=Buffer.alloc(65536);let at=0;while(at<Number(before.size)){signal.throwIfAborted();const r=await file.read(buffer,0,Math.min(buffer.length,Number(before.size)-at),at);if(!r.bytesRead)throw new ApiError(409,'Backup truncated');hash.update(buffer.subarray(0,r.bytesRead));at+=r.bytesRead;}if(version(before)!==version(await file.stat({bigint:true}))||hash.digest('hex')!==expected)throw new ApiError(409,'Backup digest conflicts');}finally{await file.close();}
  signal.throwIfAborted();if(version(before!)!==version(await lstat(path,{bigint:true})))throw new ApiError(409,'Backup changed before removal');await unlink(path);removed=true;await parent.sync();
 }catch(e){failure=e;}finally{
  try{await lock?.close();if(lockVersion){if(version(await lstat(lockPath,{bigint:true}))!==lockVersion)throw new Error('Configuration writer lock ownership changed');await unlink(lockPath);await parent.sync();}}catch(e){failure=failure?new AggregateError([failure,e],'Backup deletion and cleanup failed'):e;}
 }
 if(failure){if(removed)throw new ApiError(500,'Backup deletion durability is uncertain',{phase:'removed',backup});throw failure;}
 return {removed:true,backup,directorySynced:true};
}
