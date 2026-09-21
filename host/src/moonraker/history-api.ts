import {HistoryRepository,type HistoryJob,type HistoryAuxiliaryUpdate} from './history-repository.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError,type Json} from './rpc.ts';
import {metadataInteger,metadataNumber,pythonStrip} from './metadata-values.ts';
export interface HistoryApiOptions {
 repository:HistoryRepository;
 /** Check the current gcodes file and optional historical mtime. Must honor abort. */
 fileExists(filename:string,modified:Json|undefined,signal:AbortSignal):boolean|Promise<boolean>;
 /** Registered providers only; evaluated inside the history mutation FIFO. */
 auxiliaryTotals?():HistoryAuxiliaryUpdate[];
}
function integer(value:Json|undefined,fallback:number):number{
 if(value===undefined)return fallback;
 let result: number|undefined;
 try{if(typeof value==='boolean')result=Number(value);else if(typeof value==='number')result=Math.trunc(value);else if(typeof value==='string'&&value.length<=1024&&!/[\x1c-\x1f]/.test(value))result=metadataInteger(value);}catch{}
 if(result===undefined||!Number.isSafeInteger(result))throw new ApiError(400,'Invalid history integer argument');return result;
}
function real(value:Json|undefined):number|undefined{
 if(value===undefined)return undefined;if(typeof value==='boolean')return Number(value);if(typeof value==='number'&&Number.isFinite(value))return value;
 if(typeof value==='string'&&value.length<=1024&&!/[\x1c-\x1f]/.test(value)){
  const stripped=pythonStrip(value);
  if(/^[+-]?(?:\p{Nd}(?:_?\p{Nd})*(?:\.(?:\p{Nd}(?:_?\p{Nd})*)?)?|\.\p{Nd}(?:_?\p{Nd})*)(?:[eE][+-]?\p{Nd}(?:_?\p{Nd})*)?$/u.test(stripped)){try{return metadataNumber(stripped.replaceAll('_',''));}catch{}}
 }
 throw new ApiError(400,'Invalid history time argument');
}
function boolean(value:Json|undefined):boolean{if(value===undefined)return false;if(typeof value==='boolean')return value;if(typeof value==='string'&&['true','false'].includes(value.toLowerCase()))return value.toLowerCase()==='true';throw new ApiError(400,'Invalid history boolean argument');}
function identifier(value:Json|undefined):string{if(typeof value==='string'||typeof value==='number')return String(value);throw new ApiError(400,'Missing or invalid history uid');}
export function registerHistory(registry:EndpointRegistry,options:HistoryApiOptions,mutate:<T>(operation:()=>Promise<T>)=>Promise<T>=operation=>operation()):()=>void{
 if(!(options?.repository instanceof HistoryRepository)||typeof options.fileExists!=='function'||options.auxiliaryTotals!==undefined&&typeof options.auxiliaryTotals!=='function')throw new ApiError(400,'Invalid history API owner');
 const repository=options.repository,release:(()=>void)[]=[];
 const prepare=async(job:HistoryJob,signal:AbortSignal)=>{signal.throwIfAborted();const exists=await options.fileExists(job.filename,job.metadata.modified,signal);signal.throwIfAborted();if(typeof exists!=='boolean')throw new ApiError(502,'Invalid history file existence result');return {...job,exists};};
 try{
  release.push(registry.register({endpoint:'/server/history/job',methods:['GET','DELETE']},async(params,verb,context)=>{
   if(verb==='DELETE'){const all=boolean(params.all),id=all?'':identifier(params.uid);return mutate(()=>{context.signal.throwIfAborted();return all?repository.deleteAll():repository.delete(id);});}
   const id=identifier(params.uid),result=await prepare(await repository.get(id),context.signal);return {job:{...result,job_id:id}} as unknown as Json;
  }));
  release.push(registry.register({endpoint:'/server/history/list',methods:['GET']},async(params,_verb,context)=>{
   const result=await repository.list({before:real(params.before),since:real(params.since),limit:integer(params.limit,50),start:integer(params.start,0),order:params.order===undefined?'desc':String(params.order)}),jobs:Json[]=[];
   for(const job of result.jobs)jobs.push(await prepare(job,context.signal) as unknown as Json);return {count:jobs.length,jobs};
  }));
  release.push(registry.register({endpoint:'/server/history/totals',methods:['GET']},async()=>await repository.allTotals() as unknown as Json));
  release.push(registry.register({endpoint:'/server/history/reset_totals',methods:['POST']},async(_params,_verb,context)=>await mutate(()=>{context.signal.throwIfAborted();return repository.resetTotals(options.auxiliaryTotals?.());}) as unknown as Json));
 }catch(error){for(const undo of release)undo();throw error;}
 return ()=>{for(const undo of release)undo();};
}
