import {MaintenanceGate,MaintenanceBusyError} from '../operations/maintenance-gate.ts';
import {ApiError} from './rpc.ts';
import type {DatabaseStore} from './database.ts';
import type {EndpointRegistry} from './endpoints.ts';
export function databaseBackupName(value:unknown):string{if(typeof value!=='string'||!value||value==='.'||value==='..'||!value.isWellFormed()||Buffer.byteLength(value)>255||/[\\/\0]/.test(value))throw new ApiError(400,'Invalid database backup filename');return value;}
function timestamp():string{const now=new Date(),pad=(n:number)=>String(n).padStart(2,'0');return `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;}
/** Share this gate with every local producer; assertIdle checks the actual printer owner. */
export function registerDatabaseMaintenance(registry:EndpointRegistry,store:DatabaseStore,assertIdle:()=>void|Promise<void>,requestRestart?:()=>void,gate=new MaintenanceGate()):()=>void{
 const maintained=async<T>(operation:()=>Promise<T>):Promise<T>=>{
  let release:()=>void;try{release=gate.acquire();}catch(error){if(error instanceof MaintenanceBusyError)throw new ApiError(409,error.message);throw error;}
  try{await assertIdle();return await operation();}finally{if(store.status.restoreState!=='ready')gate.invalidate();release();}
 };
 const releases:(()=>void)[]=[];let restartIssued=false;
 try{
  releases.push(registry.register({endpoint:'/server/database/backup',methods:['POST','DELETE']},async(params,verb,context)=>{if(verb==='POST')return maintained(async()=>{context.signal.throwIfAborted();return store.backup(databaseBackupName(params.filename===undefined?`sqldb-backup-${timestamp()}.db`:params.filename));});if(params.filename===undefined)throw new ApiError(400,'Missing backup filename');return store.deleteBackup(databaseBackupName(params.filename));}));
  if(requestRestart)releases.push(registry.register({endpoint:'/server/database/restore',methods:['POST']},async(params,_verb,context)=>maintained(async()=>{
   context.signal.throwIfAborted();const filename=databaseBackupName(params.filename);if(!context.afterResponse)throw new ApiError(503,'Restore requires a response completion owner');
   let completed=false,needsRestart=false;const restart=()=>{if(completed&&needsRestart&&!restartIssued){restartIssued=true;requestRestart();}};
   context.afterResponse(()=>{completed=true;restart();});
   try{return await store.restore(filename);}finally{needsRestart=store.status.restoreState!=='ready';restart();}
  })));
  releases.push(registry.register({endpoint:'/server/database/compact',methods:['POST']},async(_params,_verb,context)=>maintained(async()=>{context.signal.throwIfAborted();return store.compact();})));
 }catch(error){for(const release of releases)release();throw error;}
 return ()=>{for(const release of releases)release();};
}
