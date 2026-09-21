import {parentPort,workerData} from 'node:worker_threads';
import {readdirSync,lstatSync} from 'node:fs';
import {DatabaseEngine,type DatabaseOptions} from './database-engine.ts';
import {ApiError,type Json} from './rpc.ts';
import type {DatabaseKey} from './database-record.ts';
const port=parentPort!,options=workerData as DatabaseOptions&{backupDirectory?:string};
const error=(e:unknown)=>({status:e instanceof ApiError?e.status:500,message:e instanceof ApiError?e.message:'Database operation failed'});
function policy(key:string,defaults:string[]):Set<string>{let values:Json;try{values=engine!.get('database',key);}catch(e){if(e instanceof ApiError&&e.status===404)return new Set(defaults);throw e;}if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))throw new ApiError(422,'Invalid persisted namespace policy');return new Set([...defaults,...values as string[]]);}
function checkReply(value:Json):void{if(Buffer.byteLength(JSON.stringify(value))>(options.maxReplyBytes??8*1024*1024))throw new ApiError(413,'Database response exceeds limit');}
function backups():string[]{if(!options.backupDirectory)return [];try{return readdirSync(options.backupDirectory,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>entry.name).sort();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
function initialize():DatabaseEngine|undefined{try{try{if(!lstatSync(options.path).isFile())throw new ApiError(400,'Database path must be a regular file');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const engine=new DatabaseEngine(options);port.postMessage({ready:true});return engine;}catch(e){port.postMessage({ready:false,error:error(e)});port.close();return undefined;}}
const engine=initialize();
if(engine)port.on('message',(message:{id:number;method:string;args:Json[]})=>{
 try{
  let value:Json=null;const [namespace,key,input]=message.args;
  switch(message.method){
   case 'get':value=engine.get(namespace as string,key as DatabaseKey|null);break;
   case 'insert':engine.insert(namespace as string,key as DatabaseKey,input);break;
   case 'delete':value=engine.delete(namespace as string,key as DatabaseKey,checkReply);break;
   case 'api-list':{const forbidden=policy('forbidden_namespaces',['database']);value={namespaces:engine.list().filter(ns=>!forbidden.has(ns)),backups:backups()};break;}
   case 'api-get':case 'api-insert':case 'api-delete':{
    if(policy('forbidden_namespaces',['database']).has(namespace as string))throw new ApiError(403,'Database namespace is forbidden');
    if(message.method!=='api-get'&&policy('protected_namespaces',['moonraker']).has(namespace as string))throw new ApiError(403,'Database namespace is read-only');
    if(message.method==='api-get')value=engine.get(namespace as string,key as DatabaseKey|null);
    else if(message.method==='api-delete')value=engine.delete(namespace as string,key as DatabaseKey,result=>checkReply({namespace,key,value:result}));
    else{checkReply({namespace,key,value:input});engine.insert(namespace as string,key as DatabaseKey,input);value=input;}
    value={namespace,key,value};break;
   }
   case 'close':engine.close();port.postMessage({id:message.id,value:null});port.close();return;
   default:throw new ApiError(400,'Unknown database method');
  }
  checkReply(value);port.postMessage({id:message.id,value});
 }catch(e){port.postMessage({id:message.id,error:error(e)});}
});
