// Response routing and query retries derived from klippy/serialhdl.py.
// Copyright (C) 2016-2021 Kevin O'Connor. GPL-3.0-or-later.
import {performance} from 'node:perf_hooks';
import {ProtocolError,MAX_PAYLOAD} from './codec.ts';
import type {ClockConnection,TimedResponse} from './clock-transport.ts';
import type {ReleaseEstimate} from '../timing/clock-sync.ts';
import type {ClockScheduler} from '../timing/clock-runtime.ts';
/** send resolves only after firmware ACK. Owns wire sequence/retry, accurate
 * timestamps and suppression of stale frames across requests. stop fences I/O. */
export interface AcknowledgedTransport {
 send(payload:Uint8Array,signal:AbortSignal):Promise<void>;
 setClockEstimate(estimate:ReleaseEstimate):void;
 stop(cause:unknown):Promise<void>;
}
export interface QueryOptions {oid?:number;timeout?:number;retries?:number}
interface Pending {start:number;deadline:number;response?:TimedResponse;notify?:()=>void;controller:AbortController}
const timing:ClockScheduler={now:()=>performance.now()/1000,schedule(callback,seconds){const timer=setTimeout(callback,seconds*1000);return ()=>clearTimeout(timer);}};
function key(name:string,oid?:number){if(!/^[a-zA-Z_][a-zA-Z_0-9]*$/.test(name)||oid!==undefined&&(!Number.isInteger(oid)||oid<0||oid>0xffffffff))throw new ProtocolError('Invalid response route');return `${name}:${oid??''}`;}
/** Read-only query layer, not a replacement for serialqueue wire reliability.
 * Retries are opt-in because repeating actuator commands can be destructive. */
export class QueryConnection implements ClockConnection {
 #transport:AcknowledgedTransport;#timing:ClockScheduler;#pending=new Map<string,Pending>();#stopPromise:Promise<void>|undefined;#closed=false;#fault:unknown;#stopError:unknown;#lastNow=0;
 constructor(transport:AcknowledgedTransport,scheduler:ClockScheduler=timing){this.#transport=transport;this.#timing=scheduler;}
 get status(){return {pending:this.#pending.size,closed:this.#closed,fault:this.#fault,stopError:this.#stopError};}
 hasPending(name:string,oid?:number):boolean{return this.#pending.has(key(name,oid));}
 #now(){const n=this.#timing.now();if(!Number.isFinite(n)||n<0||n<this.#lastNow)throw new ProtocolError('Invalid query monotonic clock');this.#lastNow=n;return n;}
 stop(cause:unknown):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#closed=true;this.#fault=cause;
  this.#stopPromise=Promise.resolve().then(()=>this.#transport.stop(cause)).catch(error=>{this.#stopError=error;throw new AggregateError([cause,error],'Query transport stop failed');});
  for(const p of this.#pending.values())p.controller.abort(cause);return this.#stopPromise;
 }
 #fail(error:unknown){void this.stop(error).catch(()=>{});}
 setClockEstimate(estimate:ReleaseEstimate):void{if(this.#closed)throw new Error('Query connection closed');try{this.#transport.setClockEstimate(estimate);}catch(error){this.#fail(error);throw error;}}
 /** Called by the decoded receive stream. Returns false for unmatched/stale data.
  * Copy values before yielding, as native receive buffers may be reused. */
 receive(reply:TimedResponse):boolean{
  if(this.#closed)return false;
  try{
   const now=this.#now(),{sentTime,receiveTime,message}=reply;
   if(!Number.isFinite(sentTime)||sentTime<0||!Number.isFinite(receiveTime)||receiveTime<sentTime||receiveTime>now)throw new ProtocolError('Invalid response timestamps');
   if(message.name.startsWith('#'))return false;
   const oid=message.parameters.oid;
   if(oid!==undefined&&typeof oid!=='number')throw new ProtocolError('Invalid response oid');
   const p=this.#pending.get(key(message.name,oid));if(!p)return false;
   if(now>=p.deadline)throw new Error('MCU query deadline exceeded');
   if(receiveTime<p.start||sentTime!==0&&sentTime<p.start)return false;
   p.response=structuredClone(reply);p.notify?.();return true;
  }catch(error){this.#fail(error);throw error;}
 }
 async query(payload:Uint8Array,responseName:string,signal:AbortSignal,options:QueryOptions={},sender:(payload:Uint8Array,signal:AbortSignal)=>Promise<void>=(p,s)=>this.#transport.send(p,s)):Promise<TimedResponse>{
  signal.throwIfAborted();if(this.#closed)throw new Error('Query connection closed');
  const route=key(responseName,options.oid),timeout=options.timeout??5,retries=options.retries??0;
  if(!payload.length||payload.length>MAX_PAYLOAD||!Number.isFinite(timeout)||timeout<=0||timeout>60||!Number.isInteger(retries)||retries<0||retries>5)throw new RangeError('Invalid query limits');
  if(this.#pending.has(route))throw new Error('Response route already in use');
  if(this.#pending.size>=128)throw new Error('Too many pending MCU queries');
  const start=this.#now(),p:Pending={start,deadline:start+timeout,controller:new AbortController()},command=payload.slice();this.#pending.set(route,p);
  const abort=()=>this.#fail(signal.reason??new Error('MCU query cancelled'));
  signal.addEventListener('abort',abort,{once:true});
  const cancel=this.#timing.schedule(()=>this.#fail(new Error('MCU query timed out')),timeout);
  try{
   for(let attempt=0;;attempt++){
    this.#check(p);
    await this.#cancellable(()=>sender(command.slice(),p.controller.signal),p);
    this.#check(p);if(p.response)return p.response;
    if(attempt===retries){
     // ACK confirms command delivery, not that its response has arrived. A
     // non-retrying query waits within its original deadline without resending.
     if(retries===0){await this.#cancellable(()=>new Promise<void>(resolve=>{p.notify=resolve;if(p.response)resolve();}),p);this.#check(p);return p.response!;}
     throw new Error(`Unable to obtain '${responseName}' response`);
    }
    await this.#delay(.010*2**attempt,p);
   }
  }catch(error){this.#fail(error);throw error;}
  finally{p.notify=undefined;cancel();signal.removeEventListener('abort',abort);this.#pending.delete(route);}
 }
 #check(p:Pending){p.controller.signal.throwIfAborted();if(this.#now()>=p.deadline)throw new Error('MCU query deadline exceeded');}
 #cancellable<T>(run:()=>Promise<T>,p:Pending):Promise<T>{return new Promise((resolve,reject)=>{
  const signal=p.controller.signal,abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
  if(signal.aborted){abort();return;}
  Promise.resolve().then(()=>{signal.throwIfAborted();return run();}).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });}
 #delay(seconds:number,p:Pending):Promise<void>{let cancel=()=>{};return this.#cancellable(()=>new Promise<void>(resolve=>{cancel=this.#timing.schedule(resolve,seconds);}),p).finally(()=>cancel());}
}
