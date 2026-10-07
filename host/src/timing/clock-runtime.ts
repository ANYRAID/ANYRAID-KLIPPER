import {performance} from 'node:perf_hooks';
import {ClockSync,type ClockSample,type ReleaseEstimate} from './clock-sync.ts';
export interface UptimeSample {high:number;clock32:number;sentTime:number;receiveTime:number}
export interface ClockTransport {
 uptime(signal:AbortSignal):Promise<UptimeSample>;
 queryClock(signal:AbortSignal):Promise<ClockSample>;
 setClockEstimate(estimate:ReleaseEstimate):void;
 /** Fence requests, cancel queued motion, and stop the affected MCU. */
 stop(cause:unknown):Promise<void>;
}
export interface ClockScheduler {now():number;schedule(callback:()=>void,seconds:number):()=>void}
const scheduler:ClockScheduler={now:()=>performance.now()/1000,schedule(callback,seconds){const timer=setTimeout(callback,seconds*1000);return ()=>clearTimeout(timer);}};
const PERIOD=.9839,STALE=5*PERIOD;
/** Single-use sampling lifecycle. Wire ACKs, duplicate suppression and accurate
 * monotonic send/receive timestamps belong to the transport. */
export class ClockRuntime {
 #frequency:number;#transport:ClockTransport;#scheduler:ClockScheduler;#sync:ClockSync|undefined;
 #state:'idle'|'starting'|'active'|'stopped'|'failed'='idle';#fault:unknown;#stopError:unknown;
 #abort=new AbortController();#stopPromise:Promise<void>|undefined;#cancel:(()=>void)|undefined;
 #lastNow=0;#expires=Infinity;#inFlight=false;#lastRequest=-Infinity;
 constructor(frequency:number,transport:ClockTransport,timing:ClockScheduler=scheduler){if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new RangeError('Invalid clock frequency');this.#frequency=frequency;this.#transport=transport;this.#scheduler=timing;}
 get status(){return {state:this.#state,fault:this.#fault,stopError:this.#stopError,inFlight:this.#inFlight};}
 get sync():ClockSync{if(!this.#sync)throw new Error('Clock is not initialized');return this.#sync;}
 #now():number{const now=this.#scheduler.now();if(!Number.isFinite(now)||now<0||now<this.#lastNow)throw new Error('Invalid monotonic clock');this.#lastNow=now;return now;}
 #end(cause:unknown,failed:boolean):Promise<void>{
  if(this.#stopPromise)return this.#stopPromise;
  this.#state=failed?'failed':'stopped';this.#fault=failed?cause:undefined;
  this.#stopPromise=Promise.resolve().then(()=>this.#transport.stop(cause)).catch(error=>{this.#stopError=error;this.#state='failed';this.#fault??=error;throw new AggregateError([cause,error],'Clock shutdown failed');});
  this.#sync?.invalidate();this.#cancel?.();this.#cancel=undefined;this.#abort.abort(cause);return this.#stopPromise;
 }
 stop(cause:unknown=new Error('Clock sampling stopped')):Promise<void>{return this.#end(cause,false);}
 #fail(error:unknown):void{void this.#end(error,true).catch(()=>{});}
 assertActive():void{
  if(this.#state!=='active')throw new Error('Clock runtime is not active');
  try{if(this.#now()>=this.#expires||!this.sync.active)throw new Error('MCU clock samples expired');}catch(error){this.#fail(error);throw error;}
 }
 #wait(seconds:number):Promise<void>{return new Promise((resolve,reject)=>{const signal=this.#abort.signal;if(signal.aborted){reject(signal.reason);return;}let cancel=()=>{};const abort=()=>{cancel();reject(signal.reason);};cancel=this.#scheduler.schedule(()=>{signal.removeEventListener('abort',abort);resolve();},seconds);signal.addEventListener('abort',abort,{once:true});});}
 async #query<T>(query:(signal:AbortSignal)=>Promise<T>,timeout:number):Promise<T>{
  const signal=this.#abort.signal;signal.throwIfAborted();const deadline=this.#now()+timeout;let cancel=()=>{},abort=()=>{};
  const controller=new AbortController();
  const failure=new Promise<never>((_,reject)=>{abort=()=>{controller.abort(signal.reason);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});cancel=this.#scheduler.schedule(()=>{const error=new Error('MCU clock query timed out');controller.abort(error);reject(error);},timeout);});
  try{const result=await Promise.race([Promise.resolve().then(()=>query(controller.signal)),failure]);if(this.#now()>=deadline){const error=new Error('MCU clock query deadline exceeded');controller.abort(error);throw error;}return result;}finally{cancel();signal.removeEventListener('abort',abort);}
 }
 #validate(sample:ClockSample,requested:number):number{
  const now=this.#now();if(!Number.isFinite(sample.receiveTime)||sample.receiveTime<requested||sample.receiveTime>now||!Number.isFinite(sample.sentTime)||(sample.sentTime!==0&&(sample.sentTime<requested||sample.sentTime>sample.receiveTime)))throw new Error('Invalid clock response timestamps');return now;
 }
 async start():Promise<void>{
  if(this.#state!=='idle')throw new Error('Clock runtime cannot restart');this.#state='starting';
  try{
   const requested=this.#now(),uptime=await this.#query(s=>this.#transport.uptime(s),5);this.#abort.signal.throwIfAborted();this.#validate(uptime,requested);
   if(!Number.isInteger(uptime.high)||uptime.high<0||uptime.high>0xffffffff||!Number.isInteger(uptime.clock32)||uptime.clock32<0||uptime.clock32>0xffffffff||uptime.sentTime===0)throw new Error('Invalid uptime response');
   this.#sync=new ClockSync(this.#frequency,(BigInt(uptime.high)<<32n)|BigInt(uptime.clock32),uptime.sentTime);
   let learned=0;
   for(let i=0;i<8;i++){await this.#wait(.05);const time=this.#now(),sample=await this.#query(s=>this.#transport.queryClock(s),5);this.#abort.signal.throwIfAborted();this.#validate(sample,time);const estimate=this.sync.accept(sample,true);if(estimate){this.#transport.setClockEstimate(estimate);learned++;this.#expires=sample.receiveTime+STALE;}}
   if(!learned)throw new Error('No usable clock warmup samples');
   // Warmup deliberately bypasses part of the outlier filter. Before granting
   // motion, qualify the existing first periodic reply under the normal model.
   // Unusable replies keep the original usable-estimate deadline, even here.
   while(!await this.#sample()){
    const now=this.#now();if(now>=this.#expires)throw new Error('MCU clock samples expired');
    await this.#wait(Math.min(this.#expires-now,Math.max(0,PERIOD-(now-this.#lastRequest))));
   }
   this.#abort.signal.throwIfAborted();this.#state='active';this.assertActive();
   this.#cancel=this.#scheduler.schedule(()=>this.#tick(),Math.max(0,PERIOD-(this.#now()-this.#lastRequest)));
  }catch(error){try{await this.#end(error,true);}catch{/* Retained in status. */}throw error;}
 }
 /** Best-effort fresh sample request. Shares the periodic query route, permits
  * only one outstanding request, and limits extra traffic to at most 20 Hz.
  * Completion must still be checked against sync.lastClock by the caller. */
 requestSample():void{
  this.assertActive();
  try{if(this.#now()-this.#lastRequest>=.05)void this.#sample().catch(error=>{if(this.#state==='active')this.#fail(error);});}catch(error){this.#fail(error);throw error;}
 }
 async #sample():Promise<boolean>{
  if(this.#inFlight)return false;
  const requested=this.#now();if(requested>=this.#expires)throw new Error('MCU clock samples expired');
  this.#inFlight=true;this.sync.querySent();this.#lastRequest=requested;
  try{const sample=await this.#query(s=>this.#transport.queryClock(s),Math.min(5,this.#expires-requested));
   this.#abort.signal.throwIfAborted();const now=this.#validate(sample,requested);if(now>=this.#expires)throw new Error('Late clock response cannot renew expired motion authorization');
   // A reply can advance raw MCU time while its estimator sample is unusable.
   // Only a published usable estimate renews the existing motion clock lease.
   const estimate=this.sync.accept(sample);if(estimate){this.#transport.setClockEstimate(estimate);this.#expires=sample.receiveTime+STALE;}return estimate!==null;
  }finally{this.#inFlight=false;}
 }
 #tick():void{
  if(this.#state!=='active')return;
  try{this.assertActive();this.#cancel=this.#scheduler.schedule(()=>this.#tick(),PERIOD);this.requestSample();}catch(error){this.#fail(error);}
 }
}
