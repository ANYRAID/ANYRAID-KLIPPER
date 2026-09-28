// Digital output rules derived from klippy/mcu.py (GPL-3.0-or-later).
import {MessageDictionary} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
import type {TimedCommandQueue} from '../protocol/serial-session.ts';
export interface DigitalConfig<T> {oid:number;pin:PinBinding<T>;start?:boolean;shutdown?:boolean;maxDuration?:number}
export interface CompiledDigital {readonly oid:number;readonly invert:0|1;readonly config:string;readonly restart:string;readonly reservedMoves:1;readonly maxDurationTicks:number;readonly initialValue:boolean;readonly shutdownValue:boolean}
export function compileDigital<T>(chip:T,dictionary:MessageDictionary,options:DigitalConfig<T>):CompiledDigital{
 const {oid,pin}=options,start=options.start??false,shutdown=options.shutdown??false,duration=options.maxDuration??2;
 if(!Number.isInteger(oid)||oid<0||oid>254||pin.chip!==chip||!pin.pin||pin.pin.length>128||/[\s^~!:]/u.test(pin.pin)||pin.pullup!==0||(pin.invert!==0&&pin.invert!==1))throw new Error('Invalid digital output binding');
 if(typeof start!=='boolean'||typeof shutdown!=='boolean'||!Number.isFinite(duration)||duration<0)throw new RangeError('Invalid digital output defaults');
 if(duration&&start!==shutdown)throw new Error('Pin with max duration must have start value equal to shutdown value');
 const raw=dictionary.constant('CLOCK_FREQ');if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)))throw new Error('Invalid output clock frequency');const frequency=Number(raw);
 if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new Error('Invalid output clock frequency');
 const ticks=Math.trunc(duration*frequency);if(!Number.isSafeInteger(ticks)||ticks>0x7fffffff||duration>0&&ticks===0)throw new RangeError('Digital pin max duration is outside the MCU tick range');
 dictionary.lookup('config_digital_out oid=%c pin=%u value=%c default_value=%c max_duration=%u');dictionary.lookup('update_digital_out oid=%c value=%c');dictionary.lookup('queue_digital_out oid=%c clock=%u on_ticks=%u');
 return Object.freeze({oid,invert:pin.invert,config:`config_digital_out oid=${oid} pin=${pin.pin} value=${Number(start)^pin.invert} default_value=${Number(shutdown)^pin.invert} max_duration=${ticks}`,restart:`update_digital_out oid=${oid} value=${Number(start)^pin.invert}`,reservedMoves:1,maxDurationTicks:ticks,initialValue:start,shutdownValue:shutdown});
}
/** Scheduled digital transitions only. The firmware max-duration guard must be
 * configured first; this is not a heater/PWM or physical emergency-stop adapter. */
export class DigitalOutput {
 #config:CompiledDigital;#dictionary:MessageDictionary;#queue:TimedCommandQueue;#clockAt:(time:number)=>bigint;#last=0n;#generation:number|undefined;#failed=false;#fault:unknown;#stop:Promise<void>|undefined;
 constructor(config:CompiledDigital,dictionary:MessageDictionary,queue:TimedCommandQueue,clockAt:(time:number)=>bigint,generation?:number){if(generation!==undefined&&(!Number.isInteger(generation)||generation<1||generation>0xffffffff))throw new RangeError('Invalid digital generation');this.#generation=generation;this.#config={...config};this.#dictionary=dictionary;this.#queue=queue;this.#clockAt=clockAt;}
 get status(){return {lastClock:this.#last,failed:this.#failed,fault:this.#fault};}
 async setDigital(printTime:number,value:boolean,signal:AbortSignal):Promise<void>{
  if(this.#failed)throw new Error('Digital output is faulted',{cause:this.#fault});signal.throwIfAborted();
  if(!Number.isFinite(printTime)||printTime<0||typeof value!=='boolean')throw new RangeError('Invalid digital output update');
  const clock=this.#clockAt(printTime);if(typeof clock!=='bigint'||clock<this.#last||clock<0n||clock>=0x7fffffffffffffffn)throw new RangeError('Digital output clock cannot rewind or overflow');
  const parameters={oid:this.#config.oid,clock:Number(BigInt.asUintN(32,clock)),on_ticks:Number(value)^this.#config.invert};
  const payload=this.#dictionary.encode(this.#generation===undefined?'queue_digital_out':'queue_digital_out_generation',this.#generation===undefined?parameters:{...parameters,generation:this.#generation});
  try{const pending=this.#queue.send(payload,this.#last,clock,signal);this.#last=clock;await pending;if(this.#failed)throw this.#fault;}
  catch(error){if(!this.#failed){this.#failed=true;this.#fault=error;this.#stop=Promise.resolve().then(()=>this.#queue.stop(error));}try{await this.#stop;}catch(stopError){throw new AggregateError([error,stopError],'Digital output and device stop failed');}throw error;}
 }
}
