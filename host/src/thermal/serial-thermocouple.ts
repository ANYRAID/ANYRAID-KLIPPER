import type {SerialSession} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {PrintClockTimeline,ClockHistoryLease} from '../timing/print-clock-timeline.ts';
import type {TemperatureSink,SensorTimer} from './serial-adc.ts';
import {max6675Temperature,thermocoupleFormats} from './max6675.ts';
const timer:SensorTimer={now:()=>serialClock.now(),schedule(callback,seconds){const handle=setInterval(callback,seconds*1000);return ()=>clearInterval(handle);}};
export interface ThermocouplePlan{oid:number;reportTicks:number;minimum:number;maximum:number;initialClock:bigint;}
/** Subscribe before MCU configuration; publish only after activation. Every
 * malformed, stale, out-of-range or chip-fault report stops the required source. */
export class SerialThermocouple {
 readonly #session:SerialSession;readonly #clock:PrintClockTimeline;readonly #sink:TemperatureSink;readonly #timer:SensorTimer;readonly #lease:ClockHistoryLease;
 #detach=()=>{};#cancel:(()=>void)|undefined;#closed=false;#active=false;#sample:readonly[number,number]|undefined;#lastClock:bigint|undefined;#received=0;#started=0;#lastNow=0;#fault:unknown;#stopError:unknown;
 constructor(session:SerialSession,plan:ThermocouplePlan,clock:PrintClockTimeline,sink:TemperatureSink,scheduler:SensorTimer=timer){
  if(!Number.isInteger(plan.oid)||plan.oid<0||plan.oid>254||!Number.isInteger(plan.reportTicks)||plan.reportTicks<1||plan.reportTicks>0x7fffffff||typeof plan.initialClock!=='bigint'||plan.initialClock<0n||plan.initialClock>=0x7fffffffffffffffn||!Number.isFinite(plan.minimum)||!Number.isFinite(plan.maximum)||plan.maximum<=plan.minimum)throw new Error('Invalid thermocouple plan');
  plan=Object.freeze({...plan});session.assertActive();this.#session=session;this.#clock=clock;this.#sink={sample:sink.sample.bind(sink),shutdown:sink.shutdown.bind(sink)};this.#timer=scheduler;clock.reserveClock(plan.initialClock);this.#lease=clock.retain();
  try{this.#detach=session.subscribeResponse(thermocoupleFormats.response,plan.oid,{receive:r=>{try{
   const p=r.message.parameters,now=this.#now();if(this.#closed)throw new Error('Thermocouple closed');
   if(r.message.name!=='thermocouple_result'||p.oid!==plan.oid||!Number.isInteger(p.next_clock)||Number(p.next_clock)<0||Number(p.next_clock)>0xffffffff||p.fault!==0||!Number.isFinite(r.receiveTime)||r.receiveTime>now||now-r.receiveTime>7)throw new Error('Thermocouple fault or invalid report');
   if(typeof p.value!=='number')throw new Error('Invalid thermocouple value');
   const tick=session.clock.sync.nearestClock(Number(p.next_clock))-BigInt(plan.reportTicks),time=clock.printTimeAtClock(tick),temperature=max6675Temperature(p.value);
   if(tick<0n||this.#lastClock!==undefined&&tick<=this.#lastClock||!Number.isFinite(time)||time<0||this.#sample&&time<=this.#sample[0]||temperature<plan.minimum||temperature>plan.maximum)throw new Error('Thermocouple sample out of range or reordered');
   this.#received=r.receiveTime;this.#sample=[time,temperature];this.#lastClock=tick;this.#fresh(now);if(this.#active)this.#sink.sample(time,temperature);this.#lease.advance(tick);
  }catch(error){this.#fail(error);throw error;}},closed:cause=>this.#close(cause)});}catch(error){this.#lease.release();throw error;}
 }
 get status(){return {active:this.#active,closed:this.#closed,fault:this.#fault,lastSample:this.#sample?[...this.#sample]:undefined};}
 #now(){const now=this.#timer.now();if(!Number.isFinite(now)||now<0||now<this.#lastNow)throw new Error('Thermocouple host clock is invalid');this.#lastNow=now;return now;}
 #fresh(now:number){if(!this.#sample){if(now-this.#started>7)throw new Error('Thermocouple first report timed out');return;}const time=this.#clock.printTimeAtClock(this.#session.clock.sync.getClock(now));if(!Number.isFinite(time)||time<0||now-this.#received>7||time-this.#sample[0]>7||this.#sample[0]-time>.3)throw new Error('Thermocouple temperature report expired or future');}
 activate(){if(this.#closed||this.#active)throw new Error('Thermocouple cannot restart');try{this.#session.assertActive();this.#session.configuration;this.#started=this.#now();this.#fresh(this.#started);this.#active=true;if(this.#sample)this.#sink.sample(...this.#sample);if(this.#closed)throw this.#fault;const cancel=this.#timer.schedule(()=>{try{this.#session.assertActive();this.#fresh(this.#now());}catch(error){this.#fail(error);}},.25);if(this.#closed){cancel();throw this.#fault;}this.#cancel=cancel;}catch(error){this.#fail(error);throw error;}}
 #close(cause:unknown){if(this.#closed)return;this.#closed=true;this.#active=false;this.#fault=cause;const errors:unknown[]=[];for(const stop of [()=>this.#cancel?.(),()=>this.#detach(),()=>this.#lease.release(),()=>this.#sink.shutdown(cause instanceof Error?cause.message:'Thermocouple stopped')])try{stop();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Thermocouple cleanup failed');}
 #fail(cause:unknown){try{this.#close(cause);}catch(error){this.#stopError=error;}void this.#session.stop(cause).catch(error=>{this.#stopError=error;});}
 async stop(cause:unknown=new Error('Thermocouple stopped')){this.#fail(cause);await this.#session.stop(cause);if(this.#stopError)throw this.#stopError;}
}
