import type {ScheduledCoolingFan} from '../outputs/fan.ts';
import {heaterFanSpeed,type HeaterFanPolicy} from './heater-fan.ts';
import type {WaitTemperature} from './temperature-wait.ts';
export interface HeaterFanTimer {schedule(callback:()=>void,seconds:number):()=>void;}
const timer:HeaterFanTimer={schedule(callback,seconds){const id=setTimeout(callback,seconds*1000);return ()=>clearTimeout(id);}};
/** Owns one already-started thermal fan. Never shares its request queue with
 * motion or M106. Cancellation settles accepted work before close completes. */
export class PeriodicFanRuntime {
 #abort=new AbortController();#cancel:(()=>void)|undefined;#pending:Promise<void>|undefined;#stop:Promise<void>|undefined;#started=false;#speed:number|undefined;#horizon=0;
 private fan:ScheduledCoolingFan;private readSpeed:()=>number;private now:()=>number;private fault:(error:unknown)=>void;private clock:HeaterFanTimer;
 constructor(fan:ScheduledCoolingFan,readSpeed:()=>number,now:()=>number,fault:(error:unknown)=>void,clock:HeaterFanTimer=timer){this.fan=fan;this.readSpeed=readSpeed;this.now=now;this.fault=fault;this.clock=clock;}
 start():void{if(this.#started||this.#abort.signal.aborted)throw new Error('Heater fan cannot restart');this.#started=true;this.#schedule(.1);}
 #schedule(delay:number):void{this.#cancel=this.clock.schedule(()=>{this.#cancel=undefined;if(this.#abort.signal.aborted)return;const pending=this.#tick();this.#pending=pending;void pending.then(()=>{if(this.#pending===pending)this.#pending=undefined;},error=>{if(this.#pending===pending)this.#pending=undefined;if(!this.#abort.signal.aborted){void this.stop(error).catch(()=>{});this.fault(error);}});},delay);}
 async #tick():Promise<void>{
  const signal=this.#abort.signal;signal.throwIfAborted();
  const now=this.now();if(!Number.isFinite(now)||now<0)throw new Error('Invalid thermal fan print clock');
  const horizon=Math.max(this.#horizon,now+.1);if(horizon<=now)throw new Error('Thermal fan print clock precision exhausted');
  const speed=this.readSpeed();
  if(speed!==this.#speed){this.fan.enqueue(horizon,speed);this.#speed=speed;}
  await this.fan.flush(horizon,signal);signal.throwIfAborted();this.#horizon=horizon;
  const next=this.fan.status.nextTime;this.#schedule(next===null?1:Math.max(.001,Math.min(1,next-now-.1)));
 }
 stop(cause:unknown=new Error('Heater fan closed')):Promise<void>{
  if(this.#stop)return this.#stop;const done=Promise.withResolvers<void>();this.#stop=done.promise;this.#abort.abort(cause);this.#cancel?.();this.#cancel=undefined;
  const pending=this.#pending;void (async()=>{const results=await Promise.allSettled([this.fan.stop(cause),pending]);const stopped=results[0];if(stopped.status==='rejected')throw stopped.reason;})().then(done.resolve,done.reject);return this.#stop;
 }
}

export class HeaterFanRuntime extends PeriodicFanRuntime {
 constructor(fan:ScheduledCoolingFan,policy:HeaterFanPolicy,read:(name:string)=>WaitTemperature,now:()=>number,fault:(error:unknown)=>void,clock:HeaterFanTimer=timer){super(fan,()=>heaterFanSpeed(policy,read),now,fault,clock);}
}
