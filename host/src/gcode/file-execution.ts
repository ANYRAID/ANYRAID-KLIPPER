import {GCodeDispatch} from './dispatch.ts';
import {GCodeFileReader,type GCodeFileBatch} from './file-reader.ts';
/** Single-owner file admission. EOF means commands consumed, never motion drained.
 * Dispatcher shutdown must be wired to the independent device safety path. */
export class GCodeFileExecution {
 #reader:GCodeFileReader;#dispatch:GCodeDispatch;#abort=new AbortController();
 #phase:'ready'|'running'|'pausing'|'paused'|'eof'|'stopping'|'stopped'|'failed'='ready';
 #task:Promise<void>|undefined;#inflight:Promise<void>|undefined;#pause:Promise<void>|undefined;
 #stop:Promise<void>|undefined;#paused=false;#wake:ReturnType<typeof Promise.withResolvers<void>>|undefined;
 #checkpoint=false;#checkpointHeld=false;
 #fault:unknown;#errors:unknown[]=[];#fenced=false;
 constructor(reader:GCodeFileReader,dispatch:GCodeDispatch){if(reader.status.closed||reader.status.pending||reader.status.eof||reader.status.fault||reader.status.position!==0||reader.status.readOffset!==0)throw new Error('File reader must be fresh with no outstanding batch');this.#reader=reader;this.#dispatch=dispatch;}
 get status(){return {...this.#reader.status,phase:this.#phase,checkpointHeld:this.#checkpointHeld&&this.#checkpoint,fault:this.#fault,cleanupErrors:[...this.#errors]};}
 /** File admission progress, not physical completion or a restart checkpoint.
  * Only whole successfully dispatched batches advance the byte position. */
 get objectStatus(){const s=this.#reader.status;return {progress:s.size?s.position/s.size:0,is_active:this.#phase==='running'||this.#phase==='pausing',file_position:s.position,file_size:s.size};}
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
   // Keep a paused suffix in this live owner only. The committed reader offset
   // advances after the whole batch, never as a crash-resume motion position.
   let batch:GCodeFileBatch|null=null,offset=0;
   while(true){
    this.#abort.signal.throwIfAborted();
    if(this.#paused){this.#wake=Promise.withResolvers<void>();await this.#wake.promise;this.#wake=undefined;continue;}
    let eof=false;
    this.#inflight=(async()=>{
     if(!batch){batch=await this.#reader.next(this.#abort.signal);this.#abort.signal.throwIfAborted();if(!batch){eof=true;return;}offset=0;}
     const completed=await this.#dispatch.executePrefix(offset?batch.script.split('\n').slice(offset).join('\n'):batch.script,()=>!this.#paused,active=>{this.#checkpoint=active;});
     this.#abort.signal.throwIfAborted();offset+=completed;
     if(offset===batch.lines){this.#reader.commit(batch);batch=null;}
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
 /** An interrupt hook must confirm a stopped active checkpoint. The original
  * command dispatch remains owned until resume; it cannot run parking G-code. */
 pause(interruptCheckpoint?:()=>Promise<void>):Promise<void>{
  if(interruptCheckpoint!==undefined&&typeof interruptCheckpoint!=='function')return Promise.reject(new TypeError('Invalid checkpoint interrupt hook'));
  if(!['running','pausing','paused'].includes(this.#phase))return Promise.reject(new Error('File execution is not running'));
  if(this.#pause)return this.#pause;
  if(this.#phase!=='running')return Promise.reject(new Error('File execution is not running'));
  const deferred=Promise.withResolvers<void>();this.#pause=deferred.promise;this.#paused=true;this.#phase='pausing';
  const held=this.#checkpoint&&interruptCheckpoint!==undefined;
  const aborted=()=>deferred.reject(this.#abort.signal.reason);this.#abort.signal.addEventListener('abort',aborted,{once:true});
  let wait:Promise<void>;
  try{wait=held?Promise.resolve(interruptCheckpoint!()):Promise.resolve(this.#inflight);}catch(error){wait=Promise.reject(error);}
  void wait.then(()=>{
   if(this.#stop||this.#fault){deferred.reject(this.#fault??new Error('File execution stopped'));return;}
   this.#checkpointHeld=held;if(this.#phase!=='eof')this.#phase='paused';deferred.resolve();
  },error=>{if(held&&!this.#stop){this.#fault=error;this.#phase='failed';this.#fence(error);}deferred.reject(error);}).finally(()=>this.#abort.signal.removeEventListener('abort',aborted));return deferred.promise;
 }
 resume():void{
  if(this.#phase!=='paused')throw new Error('File execution is not paused');
  this.#paused=false;this.#checkpointHeld=false;this.#pause=undefined;this.#phase='running';this.#wake?.resolve();
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
