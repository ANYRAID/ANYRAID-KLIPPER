import {SerialSession,type SerialSessionOptions,type TimedCommandQueue} from '../protocol/serial-session.ts';
import {connectUART,type UARTOptions} from '../protocol/uart.ts';
import type {MCUQueueConfig} from '../motion/move-queue-sink.ts';
export interface MCUConnection {
 id:string;
 /** Must wire the supplied callback into SerialSession, honor cancellation,
  * and release any acquired resources before rejecting. */
 connect(signal:AbortSignal,stopDevice:SerialSessionOptions['stopDevice']):Promise<SerialSession>;
 /** Independent physical safety path; must not await this group's stop(). */
 stopDevice(cause:unknown):Promise<void>;
}
export function uartMCU(id:string,path:string,options:UARTOptions):MCUConnection {
 const saved={...options};return {id,stopDevice:saved.stopDevice,connect:(signal,stopDevice)=>connectUART(path,{...saved,stopDevice},signal)};
}
/** Single-use MCU lifecycle. ready means communication and clocks are ready;
 * actuator configuration and homing remain separate required steps. */
export class MCUGroup {
 #entries:readonly MCUConnection[];#sessions=new Map<string,SerialSession>();#attempted=new Set<string>();
 #safety=new Map<string,Promise<void>>();#pending:Promise<void>[]=[];#lateStopErrors:unknown[]=[];
 #abort=new AbortController();#state:'idle'|'connecting'|'ready'|'stopping'|'stopped'|'failed'='idle';
 #fault:unknown;#stopError:unknown;#stopPromise:Promise<void>|undefined;
 constructor(entries:readonly MCUConnection[]){
  if(!entries.length||entries.length>16||new Set(entries.map(e=>e.id)).size!==entries.length||entries.some(e=>!/^[A-Za-z0-9_.:-]{1,128}$/.test(e.id)||typeof e.connect!=='function'||typeof e.stopDevice!=='function'))throw new Error('Invalid MCU group');
  this.#entries=entries.map(e=>({...e}));
 }
 get status(){return {state:this.#state,fault:this.#fault,stopError:this.#stopError,devices:this.#entries.map(e=>({id:e.id,attempted:this.#attempted.has(e.id),state:this.#sessions.get(e.id)?.status.state??'unavailable'}))};}
 #safe(entry:MCUConnection,cause:unknown):Promise<void>{
  let job=this.#safety.get(entry.id);if(!job){job=Promise.resolve().then(()=>entry.stopDevice(cause));this.#safety.set(entry.id,job);}return job;
 }
 async #connect(entry:MCUConnection):Promise<void>{
  // Allow start() to publish every pending task before a synchronous fault.
  await Promise.resolve();this.#abort.signal.throwIfAborted();this.#attempted.add(entry.id);
  try{
   const session=await entry.connect(this.#abort.signal,cause=>{
    // Do not await the group from a session's stop callback: group.stop() itself
    // waits for that session. Return only this device's independent safety job.
    void this.stop(cause).catch(()=>{});return this.#safe(entry,this.#fault);
   });
   if([...this.#sessions.values()].includes(session))throw new Error('MCU connections must own distinct sessions');
   this.#sessions.set(entry.id,session);
   if(this.#abort.signal.aborted){try{await session.stop(this.#fault);}catch(error){this.#lateStopErrors.push(new Error(`Late MCU ${entry.id} stop failed`,{cause:error}));}throw this.#fault;}
   if(session.status.state!=='ready')throw new Error(`MCU ${entry.id} did not become ready`);
  }catch(error){void this.stop(error).catch(()=>{});throw error;}
 }
 async start(signal:AbortSignal):Promise<void>{
  if(this.#state!=='idle')throw new Error('MCU group cannot restart');this.#state='connecting';
  const abort=()=>{void this.stop(signal.reason??new Error('MCU connection cancelled')).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{
   if(signal.aborted)abort();
   if(this.#stopPromise){await this.#stopPromise;throw this.#fault;}
   this.#pending=this.#entries.map(e=>this.#connect(e));
   const results=await Promise.allSettled(this.#pending);
   const rejected=results.find(r=>r.status==='rejected');
   if(rejected||this.#abort.signal.aborted){await this.stop(this.#fault??(rejected as PromiseRejectedResult|undefined)?.reason);throw this.#fault;}
   this.#state='ready';this.assertActive();
  }catch(error){
   try{await this.stop(error);}catch(stopError){if(error===stopError)throw error;throw new AggregateError([error,stopError],'MCU startup and group stop failed');}
   throw error;
  }finally{signal.removeEventListener('abort',abort);}
 }
 assertActive():void{
  if(this.#state!=='ready')throw new Error('MCU group is not ready',{cause:this.#fault});
  try{for(const session of this.#sessions.values())session.assertActive();}
  catch(error){void this.stop(error).catch(()=>{});throw error;}
 }
 session(id:string):SerialSession{this.assertActive();const s=this.#sessions.get(id);if(!s)throw new Error('Unknown MCU');return s;}
 commandQueue(id:string):TimedCommandQueue{
  const queue=this.session(id).commandQueue();
  return {send:async(payload,min,req,signal)=>{try{this.assertActive();await queue.send(payload,min,req,signal);this.assertActive();}catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'MCU output and group stop failed');}throw error;}},stop:cause=>this.stop(cause)};
 }
 /** Bind the motion sink to whole-group health and stop propagation. */
 motionQueue(id:string,emitters:readonly string[],clockAt:(printTime:number)=>bigint):MCUQueueConfig{
  const queue=this.session(id).motionQueue(id,emitters,clockAt);
  return {...queue,transport:{send:async packets=>{try{this.assertActive();await queue.transport.send(packets);this.assertActive();}catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'MCU motion and group stop failed');}throw error;}},stop:cause=>this.stop(cause)}};
 }
 stop(cause:unknown=new Error('MCU group stopped')):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  const deferred=Promise.withResolvers<void>();this.#stopPromise=deferred.promise;this.#state='stopping';this.#fault=cause;
  this.#abort.abort(cause);
  const stops:Promise<void>[]=[];
  for(const [id,session] of this.#sessions){try{stops.push(session.stop(cause).catch(error=>{throw new Error(`MCU ${id} stop failed`,{cause:error});}));}catch(error){stops.push(Promise.reject(error));}}
  for(const entry of this.#entries)if(this.#attempted.has(entry.id))stops.push(this.#safe(entry,cause).catch(error=>{throw new Error(`MCU ${entry.id} safety failed`,{cause:error});}));
  // Pending connectors may return a late session. #connect closes it before
  // settling, so stopping cannot incorrectly claim completion before ownership ends.
  void Promise.allSettled([...stops,...this.#pending.map(p=>p.catch(()=>{}))]).then(results=>{
   const errors=[...results.filter(r=>r.status==='rejected').map(r=>r.reason),...this.#lateStopErrors];
   if(errors.length){this.#state='failed';this.#stopError=new AggregateError(errors,'MCU group stop failed');deferred.reject(this.#stopError);}
   else{this.#state='stopped';deferred.resolve();}
  });return this.#stopPromise;
 }
}
