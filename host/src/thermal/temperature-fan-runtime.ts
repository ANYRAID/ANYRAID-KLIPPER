import {TemperatureFanControl} from './temperature-fan.ts';
import type {ScheduledCoolingFan} from '../outputs/fan.ts';
import type {HeaterFanTimer} from './heater-fan-runtime.ts';
const timer:HeaterFanTimer={schedule(callback,seconds){const id=setTimeout(callback,seconds*1000);return ()=>clearTimeout(id);}};
/** Samples and output clock must use the same synchronized print-time domain.
 * Every sample enters PID exactly once; output writes run on a bounded, serial
 * lane independent of print admission. Missing/late samples stop the owner so
 * firmware restores its configured shutdown cooling power. */
export class TemperatureFanRuntime {
 #abort=new AbortController();#started=false;#last:number|undefined;#start=0;#horizon=0;
 #queue:{time:number;speed:number}[]=[];#cancel:(()=>void)|undefined;
 #pending:Promise<void>|undefined;#closing:Promise<void>|undefined;
 #clockTime=0;
 private fan:ScheduledCoolingFan;readonly control:TemperatureFanControl;private now:()=>number;private fault:(cause:unknown)=>void;private timeout:number;private clock:HeaterFanTimer;
 constructor(fan:ScheduledCoolingFan,control:TemperatureFanControl,now:()=>number,fault:(cause:unknown)=>void,timeout=3,clock:HeaterFanTimer=timer){
  if(control.reportDelay<=.05||!Number.isFinite(timeout)||timeout<=control.reportDelay||timeout>30)throw new RangeError('Invalid temperature fan runtime timing');
  this.fan=fan;this.control=control;this.now=now;this.fault=fault;this.timeout=timeout;this.clock=clock;
 }
 start():void{
  if(this.#started||this.#abort.signal.aborted||this.fan.status.phase!=='ready')throw new Error('Temperature fan cannot start');
  this.#start=this.#readClock();this.#started=true;this.#schedule();
 }
 #readClock():number{const now=this.now();if(!Number.isFinite(now)||now<this.#clockTime)throw new Error('Invalid temperature fan clock');this.#clockTime=now;return now;}
 sample(time:number,temperature:number):void{
  if(!this.#started||this.#abort.signal.aborted)throw new Error('Temperature fan is not active');
  try{
   const now=this.#readClock();this.#checkFresh(now);
   if(time>now+this.control.reportDelay||time+this.control.reportDelay<=Math.max(now,this.#horizon))throw new Error('Temperature fan sample misses output deadline');
   if(this.#queue.length>=this.fan.capacity)throw new Error('Temperature fan sample queue exhausted');
   const event=this.control.sample(time,temperature);
   // The output starts at shutdown cooling power. Even a suppressed first
   // zero must be sent after the first valid reading authorizes cooling off.
   if(event||this.#last===undefined)this.#queue.push(event??{time:time+this.control.reportDelay,speed:this.control.state.scheduledSpeed});
   this.#last=time;
  }catch(error){this.#fail(error);throw error;}
 }
 #fail(error:unknown):void{if(this.#abort.signal.aborted)return;void this.stop(error).catch(()=>{});this.fault(error);}
 #schedule():void{this.#cancel=this.clock.schedule(()=>{
  this.#cancel=undefined;if(this.#abort.signal.aborted)return;
  // Freshness monitoring must continue even when a device write is pending.
  try{this.#checkFresh(this.#readClock());}catch(error){this.#fail(error);return;}
  this.#schedule();if(this.#pending)return;
  const pending=this.#tick();this.#pending=pending;
  void pending.then(()=>{if(this.#pending===pending)this.#pending=undefined;},error=>{if(this.#pending===pending)this.#pending=undefined;this.#fail(error);});
 },.025);}
 #checkFresh(now:number):void{if(now-(this.#last??this.#start)>this.timeout)throw new Error('Temperature fan sensor is stale');}
 async #tick():Promise<void>{
  const signal=this.#abort.signal;signal.throwIfAborted();const now=this.#readClock();
  this.#checkFresh(now);
  const next=this.fan.status.nextTime;if(next!==null&&next<=now)throw new Error('Temperature fan kick deadline missed');
  const rows=this.#queue.splice(0);
  if(rows.some(row=>row.time<=now||row.time<this.#horizon))throw new Error('Temperature fan output deadline missed');
  for(const row of rows)this.fan.enqueue(row.time,row.speed);
  const horizon=Math.max(this.#horizon,now+.05,rows.at(-1)?.time??0);
  if(horizon<=now||!Number.isFinite(horizon))throw new Error('Temperature fan clock precision exhausted');
  // Reserve before await: a concurrent sample cannot enter an already flushed
  // interval while the MCU acknowledgement is pending.
  this.#horizon=horizon;await this.fan.flush(horizon,signal);signal.throwIfAborted();
 }
 stop(cause:unknown=new Error('Temperature fan closed')):Promise<void>{
  if(this.#closing)return this.#closing;
  const done=Promise.withResolvers<void>();this.#closing=done.promise;this.#abort.abort(cause);this.#cancel?.();this.#cancel=undefined;this.#queue=[];
  const pending=this.#pending;
  void (async()=>{const results=await Promise.allSettled([this.fan.stop(cause),pending]);if(results[0].status==='rejected')throw results[0].reason;})().then(done.resolve,done.reject);
  return this.#closing;
 }
}
