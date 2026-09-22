// MCU endstop protocol derived from klippy/mcu.py (GPL-3.0-or-later).
// Original Copyright (C) 2016-2026 Kevin O'Connor.
import {MessageDictionary,type DecodedMessage} from '../protocol/dictionary.ts';
import type {PinBinding} from '../protocol/pins.ts';
export const endstopFormats=Object.freeze({
 config:'config_endstop oid=%c pin=%c pull_up=%c',
 home:'endstop_home oid=%c clock=%u sample_ticks=%u sample_count=%c rest_ticks=%u pin_value=%c trsync_oid=%c trigger_reason=%c',
 query:'endstop_query_state oid=%c',
 state:'endstop_state oid=%c homing=%c next_clock=%u pin_value=%c',
});
const maxClock=0x7fffffffffffffffn;
function integer(value:unknown,min:number,max:number):value is number{return typeof value==='number'&&Number.isInteger(value)&&value>=min&&value<=max;}
function clock(value:bigint):bigint{if(typeof value!=='bigint'||value<0n||value>maxClock)throw new RangeError('Invalid endstop clock');return value;}
export interface EndstopTiming {
 printTime:number;sampleTime:number;sampleCount:number;restTime:number;trsyncOid:number;triggered?:boolean;
}
export interface EndstopSampling {
 readonly payload:Uint8Array;readonly reqClock:bigint;readonly restTicks:bigint;
}
export interface EndstopState {readonly homing:boolean;readonly triggered:boolean;readonly nextClock32:number;}
/** Protocol boundary only. The caller must arm trsync and register every coupled
 * stepper before sending home(), stop sampling on every exit, confirm the trigger
 * reason, and reconcile MCU positions before granting homing authority. */
export class EndstopProtocol {
 readonly oid:number;readonly commands:readonly string[];readonly restart:readonly string[];
 #dictionary:MessageDictionary;#invert:number;#frequency:number;
 constructor(chip:unknown,dictionary:MessageDictionary,oid:number,pin:PinBinding<unknown>){
  if(!integer(oid,0,254)||pin.chip!==chip||typeof pin.pin!=='string'||!pin.pin||pin.pin.length>128||/[\s^~!:]/u.test(pin.pin)||!integer(pin.invert,0,1)||!integer(pin.pullup,-1,1))throw new RangeError('Invalid endstop binding');
  const raw=dictionary.constant('CLOCK_FREQ');
  if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)))throw new RangeError('Invalid endstop frequency');
  const frequency=Number(raw);if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new RangeError('Invalid endstop frequency');
  for(const format of Object.values(endstopFormats))dictionary.lookup(format);
  this.oid=oid;this.#dictionary=dictionary;this.#invert=pin.invert;this.#frequency=frequency;
  this.commands=Object.freeze([`config_endstop oid=${oid} pin=${pin.pin} pull_up=${pin.pullup}`]);
  this.restart=Object.freeze([`endstop_home oid=${oid} clock=0 sample_ticks=0 sample_count=0 rest_ticks=0 pin_value=0 trsync_oid=0 trigger_reason=0`]);
 }
 assertDictionary(dictionary:MessageDictionary):void{for(const format of Object.values(endstopFormats))if(dictionary.lookup(format).id!==this.#dictionary.lookup(format).id)throw new Error('Firmware dictionary mismatch');if(Number(dictionary.constant('CLOCK_FREQ'))!==this.#frequency)throw new Error('Firmware frequency mismatch');}
 home(options:EndstopTiming,clockAt:(time:number)=>bigint):EndstopSampling{
  const {printTime,sampleTime,sampleCount,restTime,trsyncOid,triggered=true}=options;
  if(!Number.isFinite(printTime)||printTime<0||!Number.isFinite(sampleTime)||sampleTime<=0||!Number.isFinite(restTime)||restTime<=0||!Number.isFinite(printTime+restTime)||printTime+restTime<=printTime||!integer(sampleCount,1,255)||!integer(trsyncOid,0,254)||trsyncOid===this.oid||typeof triggered!=='boolean')throw new RangeError('Invalid endstop sampling');
  const start=clock(clockAt(printTime)),restTicks=clock(clockAt(printTime+restTime))-start,sampleTicks=Math.trunc(sampleTime*this.#frequency);
  if(restTicks<=0n||restTicks>0x7fffffffn||!integer(sampleTicks,1,0x7fffffff)||sampleTicks*(sampleCount-1)>0x7fffffff)throw new RangeError('Endstop sampling exceeds scheduling range');
  const payload=this.#dictionary.encode('endstop_home',{oid:this.oid,clock:Number(BigInt.asUintN(32,start)),sample_ticks:sampleTicks,sample_count:sampleCount,rest_ticks:Number(restTicks),pin_value:Number(triggered)^this.#invert,trsync_oid:trsyncOid,trigger_reason:1});
  return {payload,reqClock:start,restTicks};
 }
 stop():Uint8Array{return this.#dictionary.encode('endstop_home',{oid:this.oid,clock:0,sample_ticks:0,sample_count:0,rest_ticks:0,pin_value:0,trsync_oid:0,trigger_reason:0});}
 query():Uint8Array{return this.#dictionary.encode('endstop_query_state',{oid:this.oid});}
 decode(message:DecodedMessage):EndstopState|undefined{
  if(message.name!=='endstop_state'||message.parameters.oid!==this.oid)return undefined;
  const p=message.parameters;if(!integer(p.homing,0,1)||!integer(p.pin_value,0,1)||!integer(p.next_clock,0,0xffffffff))throw new RangeError('Invalid endstop state');
  return {homing:!!p.homing,triggered:!!(p.pin_value^this.#invert),nextClock32:p.next_clock};
 }
 /** Call only after trsync confirms ENDSTOP_HIT for this sampling operation.
  * MCU nextwake is the first matching sample plus rest_ticks, not the last
  * debounce sample. Raw GPIO polarity after the stop is not hit evidence. */
 hitClock(state:EndstopState,sampling:EndstopSampling,expand:(raw:number)=>bigint):bigint{
  if(!integer(state.nextClock32,0,0xffffffff)||typeof sampling.restTicks!=='bigint'||sampling.restTicks<=0n||sampling.restTicks>0x7fffffffn)throw new RangeError('Invalid endstop hit state');
  const start=clock(sampling.reqClock),next=clock(expand(state.nextClock32)),hit=next-sampling.restTicks;
  if(hit<start||hit>maxClock)throw new RangeError('Endstop hit predates sampling');
  return hit;
 }
}
