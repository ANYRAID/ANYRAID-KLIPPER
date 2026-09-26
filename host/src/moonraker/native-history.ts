import type {PrintController} from '../operations/print.ts';
import {JournalError} from '../operations/print-journal.ts';
import type {JournalHistoryRecord} from '../operations/print-journal-types.ts';
import type {NativePrintUploads} from './native-print-uploads.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {historyInteger,historyTime,historyUid,historyBoolean} from './history-api.ts';
import {ApiError,type Json} from './rpc.ts';
/** Read the authoritative journal. No replica import, request deletion, or
 * synthetic timestamps; journal row IDs are stable because requests never erase. */
export function registerNativeHistory(registry:EndpointRegistry,controller:PrintController,files:NativePrintUploads):()=>void{
 const release:(()=>void)[]=[];
 const prepare=async(record:JournalHistoryRecord,signal:AbortSignal)=>{
  signal.throwIfAborted();let exists=true;try{await files.info({file_id:record.request.fileId},signal);}catch(error){if(error instanceof ApiError&&error.status===404)exists=false;else throw error;}signal.throwIfAborted();
  const active=controller.currentRequest?.requestId===record.request.requestId&&['reserved','started'].includes(record.state);
  const printDuration=active?controller.printDuration:record.statistics?.printDuration??null,totalDuration=active?controller.totalDuration:record.statistics?.totalDuration??null,filament=active?controller.filamentUsed:record.statistics?.filamentUsed??null;
  return {job_id:record.historyId,user:'unknown',filename:files.filename(record.request.fileId),status:({reserved:'in_progress',started:'in_progress',completed:'completed',cancelled:'cancelled',failed:'error',interrupted:'interrupted'} as const)[record.state],start_time:record.timestamps?.reservedAt??null,end_time:record.timestamps?.endedAt??null,total_duration:totalDuration,print_duration:printDuration,filament_used:filament,metadata:{native_request_id:record.request.requestId},auxiliary_data:[],exists} satisfies Json;
 };
 const read=async<T>(work:()=>Promise<T>):Promise<T>=>{try{return await work();}catch(error){if(error instanceof JournalError){const status=({INVALID:400,CAPACITY:413,STATE:409,MISSING:404} as Record<string,number>)[error.code]??503;throw new ApiError(status,status===503?'Native history unavailable':error.message);}throw error;}};
 try{
  release.push(registry.register({endpoint:'/server/history/job',methods:['GET','DELETE']},async(params,verb,context)=>{
   if(verb==='DELETE'){const all=historyBoolean(params.all),id=all?'':historyUid(params.uid);context.signal.throwIfAborted();return read(()=>controller.historyDelete(id,all));}
   const id=historyUid(params.uid);return read(async()=>{const record=await controller.historyGet(id);context.signal.throwIfAborted();if(!record)throw new ApiError(404,'Unknown history job');return {job:{...await prepare(record,context.signal),job_id:id}};});
  }));
  release.push(registry.register({endpoint:'/server/history/list',methods:['GET']},async(params,_verb,context)=>read(async()=>{
   const records=await controller.historyList({before:historyTime(params.before),since:historyTime(params.since),limit:historyInteger(params.limit,50),start:historyInteger(params.start,0),order:params.order===undefined?'desc':String(params.order)}),jobs:Json[]=[];
   for(const record of records)jobs.push(await prepare(record,context.signal));return {count:jobs.length,jobs};
  })));
 }catch(error){for(const undo of release.reverse())undo();throw error;}
 return ()=>{for(const undo of release.reverse())undo();};
}
