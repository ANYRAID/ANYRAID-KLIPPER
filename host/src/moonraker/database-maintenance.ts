import {ApiError} from './rpc.ts';
import type {DatabaseStore} from './database.ts';
import type {EndpointRegistry} from './endpoints.ts';
export function databaseBackupName(value:unknown):string{if(typeof value!=='string'||!value||value==='.'||value==='..'||!value.isWellFormed()||Buffer.byteLength(value)>255||/[\\/\0]/.test(value))throw new ApiError(400,'Invalid database backup filename');return value;}
function timestamp():string{const now=new Date(),pad=(n:number)=>String(n).padStart(2,'0');return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;}
/** The owner must check actual print state, not HTTP connectivity. This check
 * is admission-only; coordinating print-start with maintenance remains separate. */
export function registerDatabaseMaintenance(registry:EndpointRegistry,store:DatabaseStore,assertIdle:()=>void|Promise<void>):()=>void{
 const releases:(()=>void)[]=[];
 try{
  releases.push(registry.register({endpoint:'/server/database/backup',methods:['POST','DELETE']},async(params,verb,context)=>{if(verb==='POST'){await assertIdle();context.signal.throwIfAborted();return store.backup(databaseBackupName(params.filename===undefined?`sqldb-backup-${timestamp()}.db`:params.filename));}if(params.filename===undefined)throw new ApiError(400,'Missing backup filename');return store.deleteBackup(databaseBackupName(params.filename));}));
  releases.push(registry.register({endpoint:'/server/database/compact',methods:['POST']},async(_params,_verb,context)=>{await assertIdle();context.signal.throwIfAborted();return store.compact();}));
 }catch(error){for(const release of releases)release();throw error;}
 return ()=>{for(const release of releases)release();};
}
