import {constants} from 'node:fs';
import {open,lstat,unlink,rename} from 'node:fs/promises';
import {dirname,basename,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {assertPreparedKlipperSave,revalidateKlipperSave,type prepareKlipperSave} from './klipper-save-preflight.ts';
import type {KlipperFileLimits} from './klipper-files.ts';
type Prepared=NonNullable<Awaited<ReturnType<typeof prepareKlipperSave>>>;
export type SavePhase='before-replace'|'replace-started'|'replaced';
export class KlipperSaveCommitError extends Error {
 readonly phase:SavePhase;readonly backupPath:string|undefined;
 constructor(cause:unknown,phase:SavePhase,backupPath:string|undefined){super('Klipper configuration save failed',{cause});this.phase=phase;this.backupPath=backupPath;}
}
/** Cooperative local-file save. Other writers must honor the lock. External
 * noncooperating editors can still race the final recheck/rename interval.
 * Does not restart hardware or claim that the new config is already active. */
export async function commitKlipperSave(prepared:Prepared,limits:KlipperFileLimits={}){
 assertPreparedKlipperSave(prepared);limits.signal?.throwIfAborted();
 const path=prepared.source.primaryFile,directory=dirname(path),base=basename(path),id=randomUUID();
 const lockPath=join(directory,`.${base}.save.lock`),backupPath=join(directory,`.${base}.save-backup-${id}`),tempPath=join(directory,`.${base}.save-temp-${id}`);
 const artifacts=new Map<string,string>();let lock:Awaited<ReturnType<typeof open>>|undefined,dir:Awaited<ReturnType<typeof open>>|undefined,phase:SavePhase='before-replace',failure:unknown,backupCreated=false;
 const identity=(s:{dev:bigint;ino:bigint})=>`${s.dev}:${s.ino}`;
 const removeOwned=async(file:string)=>{const expected=artifacts.get(file);if(!expected)return;try{const s=await lstat(file,{bigint:true});if(identity(s)!==expected)throw new Error('Save artifact identity changed');await unlink(file);artifacts.delete(file);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}};
 const write=async(file:string,data:Buffer,mode:number,owner?:{uid:number;gid:number})=>{const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);try{artifacts.set(file,identity(await handle.stat({bigint:true})));await handle.writeFile(data);if(owner)await handle.chown(owner.uid,owner.gid);await handle.chmod(mode);await handle.sync();}finally{await handle.close();}};
 try{
  dir=await open(directory,constants.O_RDONLY|constants.O_DIRECTORY);lock=await open(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);artifacts.set(lockPath,identity(await lock.stat({bigint:true})));
  await revalidateKlipperSave(prepared,limits);
  const original=await open(path,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);let bytes:Buffer,mode:number,owner:{uid:number;gid:number};
  try{const before=await original.stat({bigint:true}),expected=prepared.versions[0];if(!before.isFile()||identity(before)!==expected.identity||String(before.size)!==expected.size||(before.mode&0o7000n)!==0n)throw new Error('Main config identity or mode changed');
   const chunks:Buffer[]=[];let total=0;for(;;){limits.signal?.throwIfAborted();const chunk=Buffer.allocUnsafe(Math.min(65536,Number(before.size)-total+1)),read=await original.read(chunk,0,chunk.length,null);if(!read.bytesRead)break;total+=read.bytesRead;if(total>Number(before.size))throw new Error('Main configuration grew during backup');chunks.push(chunk.subarray(0,read.bytesRead));}bytes=Buffer.concat(chunks);
   const after=await original.stat({bigint:true});if(String(after.mtimeNs)!==expected.mtimeNs||String(after.ctimeNs)!==expected.ctimeNs||String(after.mode)!==expected.mode||String(after.uid)!==expected.uid||String(after.gid)!==expected.gid||String(after.size)!==expected.size||createHash('sha256').update(bytes).digest('hex')!==expected.sha256)throw new Error('Main configuration changed during backup');mode=Number(before.mode&0o777n);owner={uid:Number(before.uid),gid:Number(before.gid)};
  }finally{await original.close();}
  await write(backupPath,bytes!,0o600);backupCreated=true;
  await write(tempPath,Buffer.from(prepared.text),mode!,owner!);await dir.sync();
  await revalidateKlipperSave(prepared,limits);limits.signal?.throwIfAborted();
  phase='replace-started';await rename(tempPath,path);artifacts.delete(tempPath);phase='replaced';await dir.sync();
 }catch(error){failure=error;}
 finally{
  try{if(phase==='before-replace'){await removeOwned(tempPath);await removeOwned(backupPath);backupCreated=false;}}catch(error){failure=failure?new AggregateError([failure,error],'Save and cleanup failed'):error;}
  try{if(lock)await lock.close();await removeOwned(lockPath);}catch(error){failure=failure?new AggregateError([failure,error],'Save and lock cleanup failed'):error;}
  try{await dir?.close();}catch(error){failure=failure?new AggregateError([failure,error],'Save and directory close failed'):error;}
 }
 if(failure)throw new KlipperSaveCommitError(failure,phase,backupCreated?backupPath:undefined);
 return Object.freeze({path,backupPath,sha256:createHash('sha256').update(prepared.text).digest('hex'),fileAndDirectorySynced:true as const});
}
