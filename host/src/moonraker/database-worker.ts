import type {SqlOperation} from './database-sql.ts';
import type {DatabaseTableDefinition} from './database-table.ts';
import {serialize} from 'node:v8';
import {createDatabaseBackup,deleteDatabaseBackup,databaseRestorePath} from './database-backup-files.ts';
import {parentPort,workerData} from 'node:worker_threads';
import {readdirSync,lstatSync} from 'node:fs';
import {DatabaseEngine,type DatabaseOptions} from './database-engine.ts';
import {ApiError,type Json} from './rpc.ts';
import type {DatabaseKey} from './database-record.ts';
const port=parentPort!,options=workerData as DatabaseOptions&{backupDirectory?:string;maxReadCacheBytes?:number};
const error=(e:unknown)=>({status:e instanceof ApiError?e.status:500,message:e instanceof ApiError?e.message:'Database operation failed',data:e instanceof ApiError?e.data:undefined});
function policy(key:string,defaults:string[]):Set<string>{let values:Json;try{values=engine!.get('database',key);}catch(e){if(e instanceof ApiError&&e.status===404)return new Set(defaults);throw e;}if(!Array.isArray(values)||values.some(v=>typeof v!=='string'))throw new ApiError(422,'Invalid persisted namespace policy');return new Set([...defaults,...values as string[]]);}
function checkReply(value:Json):void{if(Buffer.byteLength(JSON.stringify(value))>(options.maxReplyBytes??8*1024*1024))throw new ApiError(413,'Database response exceeds limit');}
function backups():string[]{if(!options.backupDirectory)return [];try{return readdirSync(options.backupDirectory,{withFileTypes:true}).filter(entry=>entry.isFile()).map(entry=>entry.name).sort();}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw e;}}
function initialize():DatabaseEngine|undefined{try{try{if(!lstatSync(options.path).isFile())throw new ApiError(400,'Database path must be a regular file');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}const engine=new DatabaseEngine(options);port.postMessage({ready:true});return engine;}catch(e){port.postMessage({ready:false,error:error(e)});port.close();return undefined;}}
const engine=initialize();
const cachedMethods=new Set(['namespace-keys','namespace-values','namespace-items']);
const readMethods=new Set([...cachedMethods,'get','get-batch','namespace-contains','namespace-length','has-namespace','api-get','api-list']);
const readCache=new Map<string,{encoded:Buffer|undefined;bytes:number}>(),cacheLimit=options.maxReadCacheBytes??8*1024*1024;
let cacheBytes=0,cacheVersion:number|undefined,cacheHits=0,cacheMisses=0;
const cacheStats=()=>({hits:cacheHits,misses:cacheMisses,entries:readCache.size,bytes:cacheBytes});
function clearReadCache(){readCache.clear();cacheBytes=0;cacheVersion=undefined;}
function remember(key:string,encoded?:Buffer){
 const bytes=(encoded?.byteLength??0)+Buffer.byteLength(key),old=readCache.get(key);if(old){cacheBytes-=old.bytes;readCache.delete(key);}if(bytes>cacheLimit)return;
 while(readCache.size&&(readCache.size>=32||cacheBytes+bytes>cacheLimit)){const oldest=readCache.keys().next().value!;cacheBytes-=readCache.get(oldest)!.bytes;readCache.delete(oldest);}
 readCache.set(key,{encoded,bytes});cacheBytes+=bytes;
}
function sendEncoded(id:number,encoded:Buffer){const copy=new Uint8Array(encoded);port.postMessage({id,encoded:copy,restoreState:engine!.restoreState,readCache:cacheStats()},[copy.buffer]);}

let commands=Promise.resolve();
if(engine)port.on('message',(message:{id:number;method:string;args:Json[]})=>{commands=commands.then(async()=>{
 try{
  if(engine.restoreState!=='ready'&&message.method!=='close')throw new ApiError(503,'Database awaits restart');
  if(!readMethods.has(message.method))clearReadCache();
  let cacheKey:string|undefined,version:number|undefined,warm=false;
  if(cacheLimit&&cachedMethods.has(message.method)){
   version=engine.dataVersion;if(version!==cacheVersion){clearReadCache();cacheVersion=version;}
   cacheKey=JSON.stringify([message.method,...message.args]);const hit=readCache.get(cacheKey);
   warm=!!hit;if(hit?.encoded){readCache.delete(cacheKey);readCache.set(cacheKey,hit);cacheHits++;sendEncoded(message.id,hit.encoded);return;}cacheMisses++;
  }
  let value:Json=null;const [namespace,key,input]=message.args;
  switch(message.method){
   case 'sql':value=engine.sql(namespace as string[],key as unknown as SqlOperation[],checkReply) as unknown as Json;break;
   case 'register-table':value=engine.registerTable(namespace as unknown as DatabaseTableDefinition,checkReply);break;
   case 'seal-tables':engine.sealTableRegistration();break;
   case 'restore':value=await engine.restore(databaseRestorePath(options.backupDirectory,namespace as string,options.path),checkReply);break;
   case 'backup':value=await createDatabaseBackup(engine,options.backupDirectory,namespace as string,options.path);break;
   case 'delete-backup':value=deleteDatabaseBackup(options.backupDirectory,namespace as string,options.path);break;
   case 'compact':value=engine.compact();break;
   case 'register-local-namespace':engine.registerLocalNamespace(namespace as string,key as boolean);break;
   case 'unregister-local-namespace':engine.unregisterLocalNamespace(namespace as string);break;
   case 'has-namespace':value=engine.hasNamespace(namespace as string);break;
   case 'register-namespace':engine.registerNamespace(namespace as string);break;
   case 'clear-namespace':engine.clearNamespace(namespace as string);break;
   case 'drop-empty-namespace':engine.dropEmptyNamespace(namespace as string);break;
   case 'namespace-keys':value=engine.namespaceEntries(namespace as string,'keys');break;
   case 'namespace-values':value=engine.namespaceEntries(namespace as string,'values');break;
   case 'namespace-items':value=engine.namespaceEntries(namespace as string,'items');break;
   case 'namespace-contains':value=engine.namespaceContains(namespace as string,key as DatabaseKey);break;
   case 'namespace-length':value=engine.namespaceLength(namespace as string);break;
   case 'get':value=engine.get(namespace as string,key as DatabaseKey|null);break;
   case 'insert':engine.insert(namespace as string,key as DatabaseKey,input);break;
   case 'update':engine.update(namespace as string,key as DatabaseKey,input);break;
   case 'sync-namespace':engine.syncNamespace(namespace as string,key as Record<string,Json>);break;
   case 'insert-batch':engine.insertBatch(namespace as string,key as Record<string,Json>);break;
   case 'get-batch':value=engine.getBatch(namespace as string,key as string[]);break;
   case 'delete-batch':value=engine.deleteBatch(namespace as string,key as string[],checkReply);break;
   case 'move-batch':engine.moveBatch(namespace as string,key as string[],input as string[]);break;
   case 'delete':value=engine.delete(namespace as string,key as DatabaseKey,checkReply);break;
   case 'api-list':{const forbidden=policy('forbidden_namespaces',['database']);value={namespaces:engine.list().filter(ns=>!forbidden.has(ns)),backups:backups()};break;}
   case 'api-get':case 'api-insert':case 'api-delete':{
    if(policy('forbidden_namespaces',['database']).has(namespace as string))throw new ApiError(403,'Database namespace is forbidden');
    if(message.method!=='api-get'&&policy('protected_namespaces',['moonraker']).has(namespace as string))throw new ApiError(403,'Database namespace is read-only');
    if(message.method==='api-get')value=engine.get(namespace as string,key as DatabaseKey|null);
    else if(message.method==='api-delete'){value=engine.delete(namespace as string,key as DatabaseKey,result=>checkReply({namespace,key,value:result}));engine.dropEmptyNamespace(namespace as string);}
    else{checkReply({namespace,key,value:input});engine.insert(namespace as string,key as DatabaseKey,input);value=input;}
    value={namespace,key,value};break;
   }
   case 'close':engine.close();port.postMessage({id:message.id,value:null,readCache:cacheStats()});port.close();return;
   default:throw new ApiError(400,'Unknown database method');
  }
  checkReply(value);
  if(cacheKey!==undefined){
   if(engine.dataVersion!==version)clearReadCache();
   else if(warm){const encoded=serialize(value);remember(cacheKey,encoded);sendEncoded(message.id,encoded);return;}
   else remember(cacheKey);
  }
  port.postMessage({id:message.id,value,restoreState:engine.restoreState,readCache:cacheStats()});
 }catch(e){port.postMessage({id:message.id,error:error(e),restoreState:engine.restoreState,readCache:cacheStats()});}
});});
