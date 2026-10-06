import {mkdirSync,realpathSync,lstatSync,mkdtempSync,openSync,closeSync,fsyncSync,renameSync,rmSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ApiError} from './rpc.ts';
import {DatabaseSync} from 'node:sqlite';
import {databaseBackupName} from './database-maintenance.ts';
import type {DatabaseEngine} from './database-engine.ts';
function destination(directory:string|undefined,name:string,source:string,create:boolean):{root:string;path:string}{
 if(!directory)throw new ApiError(503,'Database backup directory is not configured');databaseBackupName(name);if(create)mkdirSync(directory,{recursive:true,mode:0o700});let root:string;try{root=realpathSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Database backup not found');throw error;}
 const path=join(root,name),active=realpathSync(source);if([active,active+'-wal',active+'-shm',active+'-journal'].includes(resolve(path)))throw new ApiError(400,'Backup must not replace the active database');
 try{if(!lstatSync(path).isFile())throw new ApiError(400,'Backup destination must be a regular file');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 return {root,path};
}
function sync(path:string){const fd=openSync(path,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
export async function createDatabaseBackup(engine:DatabaseEngine,directory:string|undefined,name:string,source:string):Promise<{backup_path:string}>{
 const {root,path}=destination(directory,name,source,true),stage=mkdtempSync(join(root,'.database-backup-')),temporary=join(stage,'snapshot.db');let published=false;
 try{const fd=openSync(temporary,'wx',0o600);closeSync(fd);await engine.backup(temporary);
  // Normalize only the private completed snapshot. A read-only restore must
  // not leave WAL sidecars that the backup directory would advertise as files.
  const snapshot=new DatabaseSync(temporary,{timeout:1000});try{if(snapshot.prepare('PRAGMA journal_mode=DELETE').get()!.journal_mode!=='delete')throw new ApiError(503,'Backup snapshot is not standalone');}finally{snapshot.close();}
  sync(temporary);renameSync(temporary,path);published=true;sync(root);return {backup_path:path};}
 catch(error){if(published)throw new ApiError(503,'Backup publication acknowledgement failed',{mayHaveCommitted:true});throw error;}
 finally{try{rmSync(stage,{recursive:true,force:true});}catch(error){if(published)throw new ApiError(503,'Backup published but temporary directory cleanup failed',{mayHaveCommitted:true});throw error;}}
}
export function deleteDatabaseBackup(directory:string|undefined,name:string,source:string):{backup_path:string}{const {root,path}=destination(directory,name,source,false);try{unlinkSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Database backup not found');throw error;}try{sync(root);}catch{throw new ApiError(503,'Backup deletion acknowledgement failed',{mayHaveCommitted:true});}return {backup_path:path};}

export function databaseRestorePath(directory:string|undefined,name:string,source:string):string{const {path}=destination(directory,name,source,false);try{if(!lstatSync(path).isFile())throw new ApiError(400,'Restore source must be a regular file');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Database backup not found');throw error;}return path;}
