import {constants,type BigIntStats} from 'node:fs';
import {open,lstat,unlink,rename,type FileHandle} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {ApiError} from '../moonraker/rpc.ts';
import {KlipperSaveCommitError,type SavePhase} from './klipper-save-commit.ts';
import {configBackupCapacity,scanConfigBackups,removeScannedConfigBackup} from './native-config-backups.ts';
const digest=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const identity=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`;
const version=(s:{dev:bigint;ino:bigint;size:bigint;mtimeNs:bigint;ctimeNs:bigint;mode:bigint;uid:bigint;gid:bigint})=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.mode,s.uid,s.gid].map(String).join(':');
/** Raw editor replacement, including invalid configurations needed for repair.
 * Parent descriptor is borrowed and pinned by the caller. Cooperative writers
 * share the SAVE_CONFIG lock name. Noncooperating external writers can race the
 * final validation/rename interval; this is not filesystem-wide compare/swap. */
export async function replaceNativeConfig(parent:FileHandle,name:string,bytes:Buffer,expected:string|undefined,maxBytes:number,signal:AbortSignal){
 if(!name||name==='.'||name==='..'||/[\/\\\0-\x1f\x7f]/u.test(name))throw new ApiError(400,'Invalid config basename');
 const directory=`/proc/self/fd/${parent.fd}`,path=directory+'/'+name,id=randomUUID();
 const lockPath=`${directory}/.${name}.save.lock`,backupPath=`${directory}/.${name}.save-backup-${id}`,tempPath=`${directory}/.${name}.save-temp-${id}`;
 let rotatedBackup:string|null=null;const artifacts=new Map<string,string>();let lock:FileHandle|undefined,phase:SavePhase='before-replace',modified=0,failure:unknown,backupCreated=false;
 const remove=async(path:string)=>{const own=artifacts.get(path);if(!own)return;try{if(identity(await lstat(path,{bigint:true}))!==own)throw new Error('Config artifact ownership changed');await unlink(path);artifacts.delete(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}};
 const write=async(path:string,content:Buffer,mode:number,owner?:{uid:number;gid:number})=>{const file=await open(path,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{artifacts.set(path,identity(await file.stat({bigint:true})));await file.writeFile(content);if(owner)await file.chown(owner.uid,owner.gid);await file.chmod(mode);await file.sync();return (await file.stat()).mtimeMs/1000;}finally{await file.close();}};
 try{
  signal.throwIfAborted();try{lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(e){if((e as NodeJS.ErrnoException).code==='EEXIST')throw new ApiError(409,'Configuration writer lock is held');throw e;}
  artifacts.set(lockPath,identity(await lock.stat({bigint:true})));
  const scan=await scanConfigBackups(parent,name,signal);if(scan.total>configBackupCapacity||scan.total===configBackupCapacity&&!scan.backups.length)throw new ApiError(409,'Configuration backup capacity or ownership prevents rotation');const expired=scan.total===configBackupCapacity?scan.backups[0]:undefined;
  const source=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let old:Buffer,before:BigIntStats;
  try{
   before=await source.stat({bigint:true});if(!before.isFile()||before.size>BigInt(maxBytes)||(before.mode&0o7000n)!==0n)throw new ApiError(409,'Config source size or mode is unsupported');
   old=Buffer.alloc(Number(before.size));let at=0;while(at<old.length){signal.throwIfAborted();const r=await source.read(old,at,Math.min(65536,old.length-at),at);if(!r.bytesRead)throw new ApiError(409,'Config changed during backup');at+=r.bytesRead;}
   if(version(before)!==version(await source.stat({bigint:true})))throw new ApiError(409,'Config changed during backup');
   if(expected!==undefined&&digest(old)!==expected)throw new ApiError(409,'Config version conflicts; read the current file');
  }finally{await source.close();}
  signal.throwIfAborted();await write(backupPath,old!,0o600);backupCreated=true;
  modified=await write(tempPath,bytes,Number(before!.mode&0o777n),{uid:Number(before!.uid),gid:Number(before!.gid)});await parent.sync();
  signal.throwIfAborted();if(version(before!)!==version(await lstat(path,{bigint:true})))throw new ApiError(409,'Config changed before replacement');
  phase='replace-started';await rename(tempPath,path);artifacts.delete(tempPath);phase='replaced';await parent.sync();if(expired){await removeScannedConfigBackup(parent,expired,signal);rotatedBackup=expired.name;}
 }catch(e){failure=e;}finally{
  try{if(phase==='before-replace'){await remove(tempPath);await remove(backupPath);backupCreated=false;}}catch(e){failure=failure?new AggregateError([failure,e],'Config cleanup failed'):e;}
  try{await lock?.close();await remove(lockPath);await parent.sync();}catch(e){failure=failure?new AggregateError([failure,e],'Config lock cleanup failed'):e;}
 }
 if(failure){if(phase==='before-replace'){if(failure instanceof ApiError)throw failure;if(['ENOENT','ENOTDIR','ELOOP'].includes((failure as NodeJS.ErrnoException).code??''))throw new ApiError(409,'Config source or parent unavailable');}throw new KlipperSaveCommitError(failure,phase,backupCreated?`.${name}.save-backup-${id}`:undefined);}
 return {modified,rotatedBackup,sha256:digest(bytes),backup:`.${name}.save-backup-${id}`,phase:'replaced' as const,fileAndDirectorySynced:true as const};
}
