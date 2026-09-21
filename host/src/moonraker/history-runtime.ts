import {captureHistoryMetadata,type HistoryMetadataSnapshot,type HistoryMetadataProvider} from './history-metadata.ts';
import {HistoryRepository,type HistoryJob,type HistoryStats} from './history-repository.ts';
import type {JobChange} from './job-state.ts';
import {ApiError,type Json} from './rpc.ts';
export interface HistoryEvent {action:'added'|'finished';job:HistoryJob;}
export interface HistoryRuntimeOptions {metadata?:HistoryMetadataProvider;clock?:()=>number;maxPending?:number;maxPendingBytes?:number;notify?(event:HistoryEvent):void|Promise<void>;onFailure?(error:Error):void;}
type Stats=Partial<HistoryStats>;
function capture(input:Readonly<Record<string,Json>>):Stats{
 const result:Stats={};
 if(input.filename!==undefined&&input.filename!==null){if(typeof input.filename!=='string'||!input.filename.isWellFormed()||Buffer.byteLength(input.filename)>4096)throw new ApiError(502,'Invalid history filename');result.filename=input.filename;}
 for(const key of ['total_duration','print_duration','filament_used'] as const){const value=input[key];if(value===undefined||value===null)continue;if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new ApiError(502,'Invalid history statistics');result[key]=value;}
 return result;
}
function complete(value:Stats,previous?:HistoryJob):HistoryStats{return {filename:value.filename??previous?.filename??'',total_duration:value.total_duration??previous?.total_duration??0,print_duration:value.print_duration??previous?.print_duration??0,filament_used:value.filament_used??previous?.filament_used??0};}
/** Observational persistence owner. Never sends motion commands or replays events.
 * Accepted state transitions and API mutations share one bounded FIFO. */
export class HistoryRuntime {
 readonly #metadata:HistoryMetadataProvider|undefined;#metadataError:string|null=null;#metadataGeneration:string|undefined;readonly #repository:HistoryRepository;readonly #clock:()=>number;readonly #notify:HistoryRuntimeOptions['notify'];readonly #onFailure:HistoryRuntimeOptions['onFailure'];readonly #limit:number;readonly #byteLimit:number;
 #tail:Promise<void>=Promise.resolve();#pending=0;#bytes=0;#current:HistoryJob|undefined;#failure:Error|undefined;#notificationError:string|null=null;#closing:Promise<void>|undefined;#closed=false;
 constructor(repository:HistoryRepository,options:HistoryRuntimeOptions={}){
  this.#repository=repository;this.#metadata=options.metadata;this.#clock=options.clock??(()=>Date.now()/1000);this.#notify=options.notify;this.#onFailure=options.onFailure;this.#limit=options.maxPending??64;this.#byteLimit=options.maxPendingBytes??1024*1024;
  if(this.#metadata!==undefined&&typeof this.#metadata!=='function'||!(repository instanceof HistoryRepository)||typeof this.#clock!=='function'||this.#notify!==undefined&&typeof this.#notify!=='function'||this.#onFailure!==undefined&&typeof this.#onFailure!=='function'||!Number.isSafeInteger(this.#limit)||this.#limit<1||this.#limit>1024||!Number.isSafeInteger(this.#byteLimit)||this.#byteLimit<1||this.#byteLimit>8*1024*1024)throw new ApiError(400,'Invalid history runtime options');
 }
 get status(){return {pending:this.#pending,pendingBytes:this.#bytes,closing:!!this.#closing,closed:this.#closed,currentJobId:this.#current?.job_id??null,failure:this.#failure?.message??null,notificationError:this.#notificationError,metadataError:this.#metadataError};}
 #fail(error:unknown):Error{const failure=error instanceof Error?error:new Error(String(error));if(!this.#failure){this.#failure=failure;try{this.#onFailure?.(failure);}catch{}}return failure;}
 #time():number{const value=this.#clock();if(!Number.isFinite(value)||value<0)throw new ApiError(502,'Invalid history clock');return value;}
 #enqueue<T>(action:()=>Promise<T>,bytes:number,fatal:boolean):Promise<T>{
  if(this.#closing||this.#failure)return Promise.reject(new ApiError(503,'History tracking is unavailable'));
  if(this.#pending>=this.#limit||this.#bytes+bytes>this.#byteLimit){const error=new ApiError(429,'History queue capacity exceeded');if(fatal)this.#fail(error);return Promise.reject(error);}
  this.#pending++;this.#bytes+=bytes;
  const result=this.#tail.then(async()=>{if(this.#failure)throw this.#failure;return action();}).catch(error=>{if(fatal)this.#fail(error);throw error;}).finally(()=>{this.#pending--;this.#bytes-=bytes;});
  this.#tail=result.then(()=>{},()=>{});return result;
 }
 async #event(action:HistoryEvent['action'],job:HistoryJob):Promise<void>{try{await this.#notify?.({action,job:structuredClone(job)});this.#notificationError=null;}catch(error){this.#notificationError=error instanceof Error?error.message:'History notification failed';}}
 #captureMetadata(filename:string|undefined):{snapshot?:HistoryMetadataSnapshot;bytes:number}{
  if(!this.#metadata||!filename)return {bytes:0};
  try{const value=this.#metadata(filename);if(value&&typeof (value as unknown as {then?:unknown}).then==='function'){void Promise.resolve(value).catch(()=>{});throw new ApiError(502,'History metadata provider must be synchronous');}const captured=value===undefined?{bytes:0}:captureHistoryMetadata(value);this.#metadataError=null;return captured;}catch(error){this.#metadataError=error instanceof Error?error.message:'History metadata unavailable';return {bytes:0};}
 }
 async #finish(status:string,stats:Stats,time:number,metadata?:HistoryMetadataSnapshot):Promise<void>{if(!this.#current)return;const replacement=metadata&&stats.filename===this.#current.filename&&metadata.generation===this.#metadataGeneration?metadata.fields:undefined;const job=await this.#repository.finish(this.#current.job_id,status,complete(stats,this.#current),time,replacement);this.#current=undefined;this.#metadataGeneration=undefined;await this.#event('finished',job);}
 observe(change:JobChange):void{
  if(this.#closing||this.#failure||change.kind!=='state'||['paused','resumed'].includes(change.event))return;
  try{
   const event=change.event,current=capture(change.current),previous=capture(change.previous),time=this.#time(),metadata=this.#captureMetadata(event==='cancelled'||event==='standby'?previous.filename:current.filename),bytes=Buffer.byteLength(JSON.stringify([current,previous]))+metadata.bytes;
   void this.#enqueue(async()=>{
    if(event==='started'){
     await this.#finish('cancelled',previous,time);
     const job=await this.#repository.start({...complete(current),start_time:time,metadata:metadata.snapshot?.fields});this.#current=job;this.#metadataGeneration=metadata.snapshot?.generation;await this.#event('added',job);
    }else if(event==='complete')await this.#finish('completed',current,time,metadata.snapshot);
    else if(event==='error')await this.#finish('error',current,time,metadata.snapshot);
    else if(event==='cancelled'||event==='standby')await this.#finish('cancelled',previous,time,metadata.snapshot);
   },bytes,true).catch(()=>{});
  }catch(error){this.#fail(error);}
 }
 end(status:'klippy_shutdown'|'klippy_disconnect',stats:Readonly<Record<string,Json>>):void{
  if(this.#closing||this.#failure)return;
  try{const snapshot=capture(stats),time=this.#time(),metadata=this.#captureMetadata(snapshot.filename);void this.#enqueue(()=>this.#finish(status,snapshot,time,metadata.snapshot),Buffer.byteLength(JSON.stringify(snapshot))+metadata.bytes,true).catch(()=>{});}catch(error){this.#fail(error);}
 }
 /** Endpoint mutations join the same FIFO; ordinary request errors do not poison tracking. */
 mutate<T>(operation:()=>Promise<T>):Promise<T>{return this.#enqueue(operation,1,false);}
 async drain():Promise<void>{await this.#tail;if(this.#failure)throw this.#failure;}
 close(stats:Readonly<Record<string,Json>>):Promise<void>{
  if(this.#closing)return this.#closing;
  let snapshot:Stats={},time=0,metadata:HistoryMetadataSnapshot|undefined;try{snapshot=capture(stats);time=this.#time();metadata=this.#captureMetadata(snapshot.filename).snapshot;}catch(error){this.#fail(error);}
  this.#closing=this.#tail.then(async()=>{if(this.#failure)throw this.#failure;await this.#finish('server_exit',snapshot,time,metadata);}).catch(error=>{throw this.#fail(error);}).finally(()=>{this.#closed=true;});return this.#closing;
 }
}
