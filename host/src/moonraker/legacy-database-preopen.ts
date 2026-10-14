import {Worker} from 'node:worker_threads';
import {isAbsolute,resolve} from 'node:path';
import {workerEntry} from '../runtime/worker-entry.ts';
import {validateLegacyAuthorizationStartup,type LegacyAuthorizationStartup} from './legacy-authorization-startup.ts';
/** Administrator-approved offline source. This declaration cannot be supplied
 * through HTTP. It does not stop another writer or grant filesystem rights. */
export interface LegacyDatabasePreopenOptions {
 databasePath:string;sourceDirectory:string;sourceQuiescent:true;authorization:LegacyAuthorizationStartup;
}
export interface LegacyDatabasePreopenReceipt {schema:1;mode:'existing-sqlite'|'imported-lmdb';records:number;sourceSha256?:string;transaction?:string;helperSha256?:string;}
/** Private trusted-owner observation; no input/output bytes or credentials. */
export interface LegacyDatabaseProcessEvent {event:'started'|'closed';pid:number;status?:number|null;signal?:string|null;}
export function validateLegacyDatabasePreopen(options:LegacyDatabasePreopenOptions):void{
 if(!options||Object.keys(options).some(k=>!['databasePath','sourceDirectory','sourceQuiescent','authorization'].includes(k))||options.sourceQuiescent!==true)throw new TypeError('Legacy pre-open requires a trusted quiescent source declaration');
 for(const path of [options.databasePath,options.sourceDirectory])if(typeof path!=='string'||!isAbsolute(path)||resolve(path)!==path||!path.isWellFormed()||/[\0\r\n]/u.test(path)||Buffer.byteLength(path)>4096)throw new TypeError('Legacy pre-open requires canonical physical paths');
 validateLegacyAuthorizationStartup(options.authorization);
}
/** Resolves only after the worker has joined its helper and closed every
 * descriptor. Cancellation never terminates a worker with an owned child. */
export async function prepareLegacyDatabase(options:LegacyDatabasePreopenOptions,signal:AbortSignal,observe?:(event:LegacyDatabaseProcessEvent)=>void):Promise<LegacyDatabasePreopenReceipt>{
 const snapshot=structuredClone(options);validateLegacyDatabasePreopen(snapshot);signal.throwIfAborted();
 const worker=new Worker(workerEntry('./legacy-database-preopen-worker.ts',import.meta.url),{workerData:snapshot,execArgv:[]});
 let receipt:LegacyDatabasePreopenReceipt|undefined,error:unknown,helperActive=false;
 const cancelled=()=>worker.postMessage({cancel:true});signal.addEventListener('abort',cancelled,{once:true});
 const timer=setTimeout(cancelled,120000);
 try{await new Promise<void>((resolve,reject)=>{worker.on('message',message=>{if(message.receipt)receipt=message.receipt;if(message.error)error=new Error(message.error);if(message.process){helperActive=message.process.event==='started';if(observe)try{observe(message.process);}catch(cause){error=cause;cancelled();}}});worker.once('error',cause=>{error=cause;});worker.once('exit',code=>{if(helperActive)reject(new Error('Legacy pre-open worker exited with unconfirmed helper cleanup; retained recovery state requires reconciliation'));else if(code!==0||error||!receipt)reject(error??new Error('Legacy pre-open worker failed'));else resolve();});if(signal.aborted)cancelled();});signal.throwIfAborted();return receipt!;}
 finally{clearTimeout(timer);signal.removeEventListener('abort',cancelled);}
}
