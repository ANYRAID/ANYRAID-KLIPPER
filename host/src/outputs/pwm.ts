// PWM output rules derived from klippy/mcu.py (GPL-3.0-or-later).
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import type {TimedCommandQueue} from '../protocol/serial-session.ts';
export interface PWMConfig<T> {
 oid:number;pin:PinBinding<T>;hardware?:boolean;cycleTime?:number;maxDuration?:number;
 start?:number;shutdown?:number;currentPrintTime:number;
}
export interface CompiledPWM {
 readonly oid:number;readonly invert:0|1;readonly hardware:boolean;
 readonly cycleTime:number;readonly cycleTicks:number;readonly maxValue:number;
 readonly initialClock:bigint;readonly startValue:number;readonly reservedMoves:1;
 readonly commands:readonly string[];readonly restart:readonly string[];readonly init:readonly string[];
}
const maxClock=0x7fffffffffffffffn;
function constant(d:MessageDictionary,name:string):number {
 const raw=d.constant(name);
 if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)))throw new Error(`Invalid PWM ${name}`);
 const value=Number(raw);if(!Number.isFinite(value))throw new Error(`Invalid PWM ${name}`);return value;
}
function power(value:number):void{if(!Number.isFinite(value)||value<0||value>1)throw new RangeError('PWM power must be between zero and one');}
/** currentPrintTime and clockAt must belong to the same MCU mapping. */
export function compilePWM<T>(chip:T,d:MessageDictionary,options:PWMConfig<T>,clockAt:(time:number)=>bigint):CompiledPWM {
 const {oid,pin,currentPrintTime}=options,hardware=options.hardware??false,cycleTime=options.cycleTime??.1,duration=options.maxDuration??2;
 const start=options.start??0,shutdown=options.shutdown??0;power(start);power(shutdown);
 if(!Number.isInteger(oid)||oid<0||oid>254||pin.chip!==chip||!pin.pin||pin.pin.length>128||/[\s^~!:]/u.test(pin.pin)||pin.pullup!==0||(pin.invert!==0&&pin.invert!==1))throw new Error('Invalid PWM output binding');
 if(typeof hardware!=='boolean'||!Number.isFinite(cycleTime)||cycleTime<=0||!Number.isFinite(duration)||duration<0||!Number.isFinite(currentPrintTime)||currentPrintTime<0||currentPrintTime+.2<=currentPrintTime)throw new RangeError('Invalid PWM timing');
 const initialClock=clockAt(currentPrintTime+.2);if(typeof initialClock!=='bigint'||initialClock<0n||initialClock>=maxClock)throw new RangeError('Invalid PWM initial clock');
 const frequency=constant(d,'CLOCK_FREQ');if(frequency<=0||frequency>1e9)throw new RangeError('Invalid PWM clock frequency');
 const cycleTicks=Math.trunc(cycleTime*frequency),durationTicks=Math.trunc(duration*frequency);
 if(!Number.isSafeInteger(cycleTicks)||cycleTicks<1||cycleTicks>(hardware?0xffffffff:0x7fffffff)||!Number.isSafeInteger(durationTicks)||durationTicks>0x7fffffff||duration>0&&durationTicks===0)throw new RangeError('PWM duration or cycle exceeds MCU tick range');
 const startValue=pin.invert?1-start:start,shutdownValue=pin.invert?1-shutdown:shutdown;
 if(duration&&startValue!==shutdownValue)throw new Error('PWM start and shutdown values must match with max duration');
 const commands:string[]=[],restart:string[]=[],init:string[]=[],wireClock=BigInt.asUintN(32,initialClock);
 let maxValue:number;
 if(hardware){
  maxValue=constant(d,'PWM_MAX');if(!Number.isInteger(maxValue)||maxValue<1||maxValue>65535)throw new RangeError('Invalid hardware PWM range');
  d.lookup('config_pwm_out oid=%c pin=%u cycle_ticks=%u value=%hu default_value=%hu max_duration=%u');d.lookup('queue_pwm_out oid=%c clock=%u value=%hu');
  // Python's config %d truncates; restart/runtime use positive half-up rounding.
  commands.push(`config_pwm_out oid=${oid} pin=${pin.pin} cycle_ticks=${cycleTicks} value=${Math.trunc(startValue*maxValue)} default_value=${Math.trunc(shutdownValue*maxValue)} max_duration=${durationTicks}`);
  restart.push(`queue_pwm_out oid=${oid} clock=${wireClock} value=${Math.trunc(startValue*maxValue+.5)}`);
 }else{
  if(shutdownValue!==0&&shutdownValue!==1)throw new Error('Software PWM shutdown value must be zero or one');
  maxValue=cycleTicks;d.lookup('config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u');d.lookup('set_digital_out_pwm_cycle oid=%c cycle_ticks=%u');d.lookup('queue_digital_out oid=%c clock=%u on_ticks=%u');
  commands.push(`config_digital_out oid=${oid} pin=${pin.pin} value=${Number(startValue>=1)} default_value=${Number(shutdownValue>=.5)} max_duration=${durationTicks}`,`set_digital_out_pwm_cycle oid=${oid} cycle_ticks=${cycleTicks}`);
  init.push(`queue_digital_out oid=${oid} clock=${wireClock} on_ticks=${Math.trunc(startValue*cycleTicks+.5)}`);
 }
 return Object.freeze({oid,invert:pin.invert,hardware,cycleTime,cycleTicks,maxValue,initialClock,startValue,reservedMoves:1,commands:Object.freeze(commands),restart:Object.freeze(restart),init:Object.freeze(init)});
}
/** Scheduled duty updates. Does not cancel previously queued power or implement
 * physical heater shutdown; an independent safety adapter is still required. */
export class PWMOutput {
 #config:CompiledPWM;#dictionary:MessageDictionary;#queue:TimedCommandQueue;
 #clockAt:(time:number)=>bigint;#printAt:(clock:bigint)=>number;#last:bigint;#value:number;
 #failed=false;#fault:unknown;#stop:Promise<void>|undefined;
 constructor(config:CompiledPWM,dictionary:MessageDictionary,queue:TimedCommandQueue,clockAt:(time:number)=>bigint,printAt:(clock:bigint)=>number){this.#config={...config};this.#dictionary=dictionary;this.#queue=queue;this.#clockAt=clockAt;this.#printAt=printAt;this.#last=config.initialClock;this.#value=config.startValue;}
 get status(){return {lastClock:this.#last,lastValue:this.#value,failed:this.#failed,fault:this.#fault};}
 nextAlignedPrintTime(printTime:number,allowEarly=0):number {
  if(this.#failed)throw new Error('PWM output is faulted',{cause:this.#fault});
  if(!Number.isFinite(printTime)||printTime<0||!Number.isFinite(allowEarly)||allowEarly<0)throw new RangeError('Invalid PWM alignment time');
  if(this.#config.hardware||this.#value===0||this.#value===1)return printTime;
  const request=this.#clockAt(printTime-Math.min(allowEarly,.5*this.#config.cycleTime));
  if(typeof request!=='bigint'||request<=-maxClock||request>=maxClock)throw new RangeError('Invalid PWM alignment clock');
  const cycle=BigInt(this.#config.cycleTicks),delta=request-this.#last;
  // BigInt division truncates toward zero; ceil must also work for negative deltas.
  const pulses=delta/cycle+(delta>0n&&delta%cycle!==0n?1n:0n),next=this.#last+pulses*cycle;
  if(next<0n||next>=maxClock)throw new RangeError('PWM alignment clock overflow');
  const time=this.#printAt(next);if(!Number.isFinite(time)||time<0)throw new RangeError('Invalid PWM clock mapping');return time;
 }
 async setPWM(printTime:number,value:number,signal:AbortSignal):Promise<void>{
  if(this.#failed)throw new Error('PWM output is faulted',{cause:this.#fault});signal.throwIfAborted();power(value);
  if(!Number.isFinite(printTime)||printTime<0)throw new RangeError('Invalid PWM update time');
  const clock=this.#clockAt(printTime);if(typeof clock!=='bigint'||clock<this.#last||clock<0n||clock>=maxClock)throw new RangeError('PWM clock cannot rewind or overflow');
  const duty=this.#config.invert?1-value:value,ticks=Math.trunc(duty*this.#config.maxValue+.5);
  const payload=this.#dictionary.encode(this.#config.hardware?'queue_pwm_out':'queue_digital_out',this.#config.hardware?{oid:this.#config.oid,clock:Number(BigInt.asUintN(32,clock)),value:ticks}:{oid:this.#config.oid,clock:Number(BigInt.asUintN(32,clock)),on_ticks:ticks});
  try{const pending=this.#queue.send(payload,this.#last,clock,signal);this.#last=clock;this.#value=duty;await pending;if(this.#failed)throw this.#fault;}
  catch(error){if(!this.#failed){this.#failed=true;this.#fault=error;this.#stop=Promise.resolve().then(()=>this.#queue.stop(error));}try{await this.#stop;}catch(stopError){throw new AggregateError([error,stopError],'PWM output and device stop failed');}throw error;}
 }
}
