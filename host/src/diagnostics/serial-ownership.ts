import {readdir,stat} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
export class SerialInUseError extends Error {readonly pid:string;constructor(pid:string){super(`Serial device is in use by process ${pid}`);this.pid=pid;}}
const transient=(error:unknown)=>['ENOENT','ENOTDIR','ESRCH'].includes((error as NodeJS.ErrnoException).code??'');
const denied=(error:unknown)=>['EACCES','EPERM'].includes((error as NodeJS.ErrnoException).code??'');
/** Best-effort /proc inspection, before the owning native flock/open. This is
 * not atomic exclusion: hidden/denied processes and subsequent opens remain
 * outside its proof. No signals or process command lines are read. */
export async function assertSerialAvailable(device:string,signal:AbortSignal,procRoot='/proc'):Promise<{processes:number;descriptors:number;inaccessible:number}>{
 signal.throwIfAborted();if(!isAbsolute(device)||device.includes('\0')||!isAbsolute(procRoot)||procRoot.includes('\0'))throw new TypeError('Invalid serial ownership path');
 const target=await stat(device,{bigint:true});if(!target.isCharacterDevice())throw new Error('Serial device must be a character device');
 const pids=(await readdir(procRoot)).filter(pid=>/^\d+$/.test(pid));let processes=0,descriptors=0,inaccessible=0;
 for(const pid of pids){
  signal.throwIfAborted();let names:string[];try{names=await readdir(join(procRoot,pid,'fd'));}catch(error){if(transient(error))continue;if(denied(error)){inaccessible++;continue;}throw error;}
  processes++;
  for(let offset=0;offset<names.length;offset+=16){
   signal.throwIfAborted();const batch=await Promise.all(names.slice(offset,offset+16).map(async name=>{
    try{const opened=await stat(join(procRoot,pid,'fd',name),{bigint:true});return opened.dev===target.dev&&opened.ino===target.ino||opened.isCharacterDevice()&&opened.rdev===target.rdev;}
    catch(error){if(transient(error))return false;if(denied(error)){inaccessible++;return false;}throw error;}
   }));descriptors+=batch.length;signal.throwIfAborted();if(batch.some(Boolean))throw new SerialInUseError(pid);
  }
 }
 signal.throwIfAborted();return {processes,descriptors,inaccessible};
}
