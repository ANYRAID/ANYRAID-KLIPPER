import type {PrintController} from '../operations/print.ts';
import {JournalError,type PrintJournal} from '../operations/print-journal.ts';
import type {JournalHistoryRecord,JournalHistoryEvent} from '../operations/print-journal-types.ts';
import type {NativePrintUploads} from './native-print-uploads.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {historyInteger,historyTime,historyUid,historyBoolean} from './history-api.ts';
import {ApiError,type Json} from './rpc.ts';
/** Read the authoritative journal. No replica import, request deletion, or
 * synthetic timestamps; journal row IDs are stable because requests never erase. */
export function registerNativeHistory(registry:EndpointRegistry,source:PrintController|PrintJournal,files:NativePrintUploads,notify?:(event:Json)=>void|Promise<void>,current?:()=>PrintController|undefined){
 const release:(()=>void)[]=[];
 const lifetime=new AbortController();let pending=0,dropped=0,error:string|null=null,closed=false,tail=Promise.resolve();
 const status=()=>({pending,dropped,error,closed});
 const cleanup=Object.assign(()=>{if(closed)return;closed=true;lifetime.abort(new Error('Native history closed'));for(const undo of release.reverse())undo();},{status,drain:async()=>{cleanup();await tail;}});
 const prepare=async(record:JournalHistoryRecord,signal:AbortSignal,live=true)=>{
  signal.throwIfAborted();let exists=true;try{await files.info({file_id:record.request.fileId},signal);}catch(error){if(error instanceof ApiError&&error.status===404)exists=false;else throw error;}signal.throwIfAborted();
  const controller=current?current():('currentRequest' in source?source:undefined);
  const active=live&&controller?.currentRequest?.requestId===record.request.requestId&&['reserved','started'].includes(record.state);
  const printDuration=active?controller!.printDuration:record.statistics?.printDuration??null,totalDuration=active?controller!.totalDuration:record.statistics?.totalDuration??null,filament=active?controller!.filamentUsed:record.statistics?.filamentUsed??null;
  return {job_id:record.historyId,user:'unknown',filename:files.filename(record.request.fileId),status:({reserved:'in_progress',started:'in_progress',completed:'completed',cancelled:'cancelled',failed:'error',interrupted:'interrupted'} as const)[record.state],start_time:record.timestamps?.reservedAt??null,end_time:record.timestamps?.endedAt??null,total_duration:totalDuration,print_duration:printDuration,filament_used:filament,metadata:{native_request_id:record.request.requestId},auxiliary_data:[],exists} satisfies Json;
 };
 const read=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){if(error instanceof JournalError){const status=({INVALID:400,CAPACITY:413,STATE:409,MISSING:404} as Record<string,number>)[error.code]??503;throw new ApiError(status,status===503?'Native history unavailable':error.message);}throw error;}};
 const observe=(event:JournalHistoryEvent)=>{
  if(closed||!notify)return;
  if(pending>=64){dropped++;error='Native history notification queue full; refresh history';return;}
  pending++;
  tail=tail.then(async()=>{if(closed)return;const job=await prepare(event.record,lifetime.signal,false);lifetime.signal.throwIfAborted();await notify({action:event.action,job});}).catch(cause=>{if(!closed)error=cause instanceof Error?cause.message:'Native history notification failed';}).finally(()=>{pending--;});
 };
 try{
  if(notify)release.push(source.subscribeHistory(observe));
  release.push(registry.register({endpoint:'/server/history/job',methods:['GET','DELETE']},async(params,verb,context)=>{
   if(verb==='DELETE'){const all=historyBoolean(params.all),id=all?'':historyUid(params.uid);context.signal.throwIfAborted();return read(()=>source.historyDelete(id,all));}
   const id=historyUid(params.uid);return read(async()=>{const record=await source.historyGet(id);context.signal.throwIfAborted();if(!record)throw new ApiError(404,'Unknown history job');return {job:{...await prepare(record,context.signal),job_id:id}};});
  }));
  release.push(registry.register({endpoint:'/server/history/list',methods:['GET']},async(params,_verb,context)=>read(async()=>{
   const records=await source.historyList({before:historyTime(params.before),since:historyTime(params.since),limit:historyInteger(params.limit,50),start:historyInteger(params.start,0),order:params.order===undefined?'desc':String(params.order)}),jobs:Json[]=[];
   for(const record of records)jobs.push(await prepare(record,context.signal));return {count:jobs.length,jobs};
  })));
  release.push(registry.register({endpoint:'/server/history/totals',methods:['GET']},async()=>read(async()=>await source.historyTotals() as unknown as Json)));
  release.push(registry.register({endpoint:'/server/history/reset_totals',methods:['POST']},async(_params,_verb,context)=>read(async()=>{context.signal.throwIfAborted();return await source.historyResetTotals() as unknown as Json;})));
 }catch(error){cleanup();throw error;}
 return cleanup;
}
