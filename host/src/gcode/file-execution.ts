import {GCodeDispatch} from './dispatch.ts';
import {GCodeFileReader} from './file-reader.ts';
/** Single-owner file admission. EOF means commands consumed, never motion drained.
 * Dispatcher shutdown must be wired to the independent device safety path. */
export class GCodeFileExecution {
 #reader:GCodeFileReader;#dispatch:GCodeDispatch;#abort=new AbortController();
 #phase:'ready'|'running'|'pausing'|'paused'|'eof'|'stopping'|'stopped'|'failed'='ready';
 #task:Promise<void>|undefined;#inflight:Promise<void>|undefined;#pause:Promise<void>|undefined;
 #stop:Promise<void>|undefined;#paused=false;#wake:ReturnType<typeof Promise.withResolvers<void>>|undefined;
 #fault:unknown;#errors:unknown[]=[];#fenced=false;
 constructor(reader:GCodeFileReader,dispatch:GCodeDispatch){if(reader.status.closed||reader.status.pending||reader.status.eof||reader.status.fault||reader.status.position!==0||reader.status.readOffset!==0)throw new Error('File reader must be fresh with no outstanding batch');this.#reader=reader;this.#dispatch=dispatch;}
 get status(){return {...this.#reader.status,phase:this.#phase,fault:this.#fault,cleanupErrors:[...this.#errors]};}
 start():Promise<void>{
  if(this.#task)return this.#task;if(this.#phase!=='ready')return Promise.reject(new Error('File execution cannot restart'));
  this.#phase='running';this.#task=Promise.resolve().then(()=>this.#run());void this.#task.catch(()=>{});return this.#task;
 }
 #fence(reason:unknown):void{
  if(this.#fenced)return;this.#fenced=true;
  try{this.#dispatch.emergencyStop(reason instanceof Error?reason.message:String(reason));}catch(error){this.#errors.push(error);}
 }
 async #run():Promise<void>{
  try{
   while(true){
    this.#abort.signal.throwIfAborted();
    if(this.#paused){this.#wake=Promise.withResolvers<void>();await this.#wake.promise;this.#wake=undefined;continue;}
    let eof=false;
    this.#inflight=(async()=>{
     const batch=await this.#reader.next(this.#abort.signal);this.#abort.signal.throwIfAborted();
     if(!batch){eof=true;return;}
     await this.#dispatch.execute(batch.script);this.#abort.signal.throwIfAborted();this.#reader.commit(batch);
    })();
    try{await this.#inflight;}finally{this.#inflight=undefined;}
    if(eof)break;
    // Do not starve timers or external cancellation when commands resolve immediately.
    await new Promise<void>(resolve=>setImmediate(resolve));
   }
   await this.#reader.close();this.#abort.signal.throwIfAborted();this.#phase='eof';
  }catch(error){
   if(!this.#stop){this.#fault=error;this.#phase='failed';this.#fence(error);}
   try{await this.#reader.close();}catch(closeError){this.#errors.push(closeError);}
   if(this.#errors.length)throw new AggregateError([error,...this.#errors],'File execution and cleanup failed',{cause:error});throw error;
  }
 }
 pause():Promise<void>{
  if(!['running','pausing','paused'].includes(this.#phase))return Promise.reject(new Error('File execution is not running'));
  if(this.#pause)return this.#pause;
  if(this.#phase!=='running')return Promise.reject(new Error('File execution is not running'));
  const deferred=Promise.withResolvers<void>();this.#pause=deferred.promise;this.#paused=true;this.#phase='pausing';
  void Promise.resolve(this.#inflight).then(()=>{
   if(this.#stop||this.#fault){deferred.reject(this.#fault??new Error('File execution stopped'));return;}
   if(this.#phase!=='eof')this.#phase='paused';deferred.resolve();
  },deferred.reject);return deferred.promise;
 }
 resume():void{
  if(this.#phase!=='paused')throw new Error('File execution is not paused');
  this.#paused=false;this.#pause=undefined;this.#phase='running';this.#wake?.resolve();
 }
 stop(cause:unknown=new Error('File execution stopped')):Promise<void>{
  if(this.#stop)return this.#stop;
  const deferred=Promise.withResolvers<void>();this.#stop=deferred.promise;this.#phase='stopping';
  this.#abort.abort(cause);this.#wake?.resolve();this.#fence(cause);
  // Start closing now; wait for all reads and handlers before reporting quiescence.
  const close=this.#reader.close();
  void Promise.allSettled([this.#task,close]).then(results=>{
   if(results[1].status==='rejected')this.#errors.push(results[1].reason);
   if(this.#errors.length){this.#phase='failed';deferred.reject(new AggregateError([...this.#errors],'File execution stop failed',{cause}));}
   else{this.#phase='stopped';deferred.resolve();}
  });return deferred.promise;
 }
}
