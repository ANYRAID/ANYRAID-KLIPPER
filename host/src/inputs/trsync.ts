// Trigger synchronization protocol derived from klippy/mcu.py (GPL-3.0-or-later).
// Original Copyright (C) 2016-2026 Kevin O'Connor.
import {MessageDictionary,type DecodedMessage} from '../protocol/dictionary.ts';
export const triggerReason=Object.freeze({endstopHit:1,hostRequest:2,pastEndTime:3,commsTimeout:4});
export const trsyncFormats=Object.freeze({
 config:'config_trsync oid=%c',
 start:'trsync_start oid=%c report_clock=%u report_ticks=%u expire_reason=%c',
 timeout:'trsync_set_timeout oid=%c clock=%u',
 trigger:'trsync_trigger oid=%c reason=%c',
 state:'trsync_state oid=%c can_trigger=%c trigger_reason=%c clock=%u',
 stepper:'stepper_stop_on_trigger oid=%c trsync_oid=%c',
});
const maxClock=0x7fffffffffffffffn;
function uint(value:unknown,max:number):value is number{return typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=max;}
function validClock(value:bigint):bigint{if(typeof value!=='bigint'||value<0n||value>maxClock)throw new RangeError('Invalid trsync clock');return value;}
function low(clock:bigint):number{return Number(BigInt.asUintN(32,clock));}
export interface TriggerPacket {readonly data:Uint8Array;readonly min:bigint;readonly req:bigint;}
export interface TriggerPlan {
 readonly startClock:bigint;readonly expireClock:bigint;readonly expireTicks:bigint;readonly minExtendTicks:bigint;
 readonly reportTicks:number;readonly reportClock:bigint;readonly packets:readonly TriggerPacket[];
}
export interface TriggerState {readonly canTrigger:boolean;readonly reason:number;readonly clock32:number;readonly failure:boolean;}
/** Creates commands and native-dispatch setup values without sending anything.
 * Every stepper OID must belong to this MCU. Multi-MCU fanout and watchdog renewal
 * must run in the native serial fastreader, not a JavaScript timer. */
export class TriggerSyncProtocol {
 readonly oid:number;readonly commands:readonly string[];readonly restart:readonly string[];
 readonly tags:Readonly<{timeout:number;trigger:number;state:number}>;
 #dictionary:MessageDictionary;#frequency:number;
 constructor(dictionary:MessageDictionary,oid:number){
  if(!uint(oid,254))throw new RangeError('Invalid trsync OID');
  const raw=dictionary.constant('CLOCK_FREQ');
  if(typeof raw!=='number'&&(typeof raw!=='string'||!/^\+?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(raw)))throw new RangeError('Invalid trsync frequency');
  const frequency=Number(raw);if(!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new RangeError('Invalid trsync frequency');
  for(const format of Object.values(trsyncFormats))dictionary.lookup(format);
  this.#dictionary=dictionary;this.#frequency=frequency;this.oid=oid;
  this.tags=Object.freeze({timeout:dictionary.lookup(trsyncFormats.timeout).id>>>0,trigger:dictionary.lookup(trsyncFormats.trigger).id>>>0,state:dictionary.lookup(trsyncFormats.state).id>>>0});
  this.commands=Object.freeze([`config_trsync oid=${oid}`]);
  this.restart=Object.freeze([`trsync_start oid=${oid} report_clock=0 report_ticks=0 expire_reason=0`]);
 }
 assertDictionary(dictionary:MessageDictionary):void{for(const format of Object.values(trsyncFormats))if(dictionary.lookup(format).id!==this.#dictionary.lookup(format).id)throw new Error('Firmware dictionary mismatch');if(Number(dictionary.constant('CLOCK_FREQ'))!==this.#frequency)throw new Error('Firmware frequency mismatch');}
 start(startClock:bigint,stepperOids:readonly number[],expireTimeout:number,reportOffset=0):TriggerPlan{
  validClock(startClock);
  if(!Array.isArray(stepperOids)||stepperOids.length<1||stepperOids.length>254||stepperOids.some(oid=>!uint(oid,254)||oid===this.oid)||new Set(stepperOids).size!==stepperOids.length)throw new RangeError('Invalid trsync stepper OIDs');
  if(!Number.isFinite(expireTimeout)||expireTimeout<=0||!Number.isFinite(reportOffset)||reportOffset<0||reportOffset>=1)throw new RangeError('Invalid trsync timing');
  const expireTicks=Math.trunc(expireTimeout*this.#frequency),reportTicks=Math.trunc(expireTimeout*.3*this.#frequency),minExtendTicks=Math.trunc(reportTicks*.8+.5);
  if(!uint(expireTicks,0x7fffffff)||expireTicks<1||!uint(reportTicks,0x7fffffff)||reportTicks<1||minExtendTicks<1)throw new RangeError('Invalid trsync tick range');
  const expireClock=validClock(startClock+BigInt(expireTicks)),reportClock=validClock(startClock+BigInt(Math.trunc(reportTicks*reportOffset+.5)));
  const packets:TriggerPacket[]=[{data:this.#dictionary.encode('trsync_start',{oid:this.oid,report_clock:low(reportClock),report_ticks:reportTicks,expire_reason:triggerReason.commsTimeout}),min:0n,req:startClock}];
  for(const oid of stepperOids)packets.push({data:this.#dictionary.encode('stepper_stop_on_trigger',{oid,trsync_oid:this.oid}),min:0n,req:0n});
  packets.push({data:this.#dictionary.encode('trsync_set_timeout',{oid:this.oid,clock:low(expireClock)}),min:0n,req:startClock});
  return Object.freeze({startClock,expireClock,expireTicks:BigInt(expireTicks),minExtendTicks:BigInt(minExtendTicks),reportTicks,reportClock,packets:Object.freeze(packets.map(p=>Object.freeze(p)))});
 }
 trigger(reason:number):Uint8Array{
  if(!uint(reason,255)||reason===0)throw new RangeError('Invalid trsync trigger reason');
  return this.#dictionary.encode('trsync_trigger',{oid:this.oid,reason});
 }
 decode(message:DecodedMessage):TriggerState|undefined{
  if(message.name!=='trsync_state'||message.parameters.oid!==this.oid)return undefined;
  const p=message.parameters;
  if(!uint(p.can_trigger,1)||!uint(p.trigger_reason,255)||!uint(p.clock,0xffffffff)||p.can_trigger===1&&p.trigger_reason!==0)throw new RangeError('Invalid trsync state');
  // Inactive reason 0 is an unarmed/reset MCU, never successful homing.
  return {canTrigger:!!p.can_trigger,reason:p.trigger_reason,clock32:p.clock,failure:!p.can_trigger&&(p.trigger_reason===0||p.trigger_reason>=triggerReason.commsTimeout)};
 }
}
