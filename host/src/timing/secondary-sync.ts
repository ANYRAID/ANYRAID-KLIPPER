// Secondary MCU calibration model from klippy/clocksync.py, GPL-3.0-or-later.
import {ClockSync} from './clock-sync.ts';
import type {MotionCoordinator} from '../motion/coordinator.ts';
export interface SecondaryCalibration {readonly offset:number;readonly frequency:number;readonly syncTime:number}
const LIMIT=BigInt(Number.MAX_SAFE_INTEGER);
function exact(clock:bigint):number{if(clock<0n||clock>LIMIT)throw new RangeError('Secondary clock exceeds exact native scheduling range');return Number(clock);}
function time(value:number):void{if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid secondary synchronization time');}
/** Proposals do not change the active mapping. Apply through the motion coordinator
 * only after every emitter on the secondary MCU accepts the calibration. */
export class SecondarySync {
 #main:ClockSync;#local:ClockSync;#offset:number;#frequency:number;#syncTime=0;#revision=0;
 #proposals=new WeakMap<object,{revision:number;main:number;local:number}>();
 constructor(main:ClockSync,local:ClockSync,eventTime:number){
  time(eventTime);if(main===local)throw new Error('Secondary MCU must differ from primary');this.#main=main;this.#local=local;
  this.#frequency=local.nominalFrequency;
  this.#offset=exact(main.getClock(eventTime))/main.nominalFrequency-exact(local.getClock(eventTime))/local.nominalFrequency;
  const first=this.propose(0,eventTime);this.#offset=first.offset;this.#frequency=first.frequency;this.#syncTime=first.syncTime;this.#revision++;
 }
 get mapping():SecondaryCalibration{return {offset:this.#offset,frequency:this.#frequency,syncTime:this.#syncTime};}
 printTimeToClock(printTime:number):bigint{time(printTime);const clock=Math.trunc((printTime-this.#offset)*this.#frequency);if(!Number.isSafeInteger(clock)||clock<0)throw new RangeError('Invalid secondary print clock');return BigInt(clock);}
 clockToPrintTime(clock:bigint):number{const value=exact(clock)/this.#frequency+this.#offset;if(!Number.isFinite(value))throw new RangeError('Secondary time overflow');return value;}
 propose(printTime:number,eventTime:number):Readonly<SecondaryCalibration>{
  time(printTime);time(eventTime);if(!this.#main.active||!this.#local.active)throw new Error('MCU clock synchronization is inactive');
  const main=this.#main.estimate,serClock=exact(main.origin)+main.clockOffset;
  const estimatedClock=(eventTime-main.sampleTime)*main.frequency+serClock;
  if(!Number.isFinite(estimatedClock)||estimatedClock<0||estimatedClock>Number.MAX_SAFE_INTEGER)throw new RangeError('Primary estimate exceeds exact native scheduling range');
  const estimated=estimatedClock/this.#main.nominalFrequency;
  const first=Math.max(printTime,estimated),second=Math.max(first+4,this.#syncTime,printTime+2.5*(printTime-estimated));
  const system=main.sampleTime+(second*this.#main.nominalFrequency-serClock)/main.frequency;
  if(!Number.isFinite(second)||second<=first||!Number.isFinite(system)||system<0)throw new RangeError('Secondary sync horizon exceeds numeric resolution');
  const firstClock=this.printTimeToClock(first),secondClock=this.#local.getClock(system);exact(secondClock);
  const delta=secondClock-firstClock;if(delta<=0n||delta>LIMIT)throw new RangeError('Nonpositive or inexact secondary clock slope');
  const frequency=Number(delta)/(second-first),offset=first-exact(firstClock)/frequency;
  if(!Number.isFinite(offset)||!Number.isFinite(frequency)||frequency<=0||frequency>1e9)throw new RangeError('Invalid secondary clock adjustment');
  const result=Object.freeze({offset,frequency,syncTime:second});this.#proposals.set(result,{revision:this.#revision,main:this.#main.revision,local:this.#local.revision});return result;
 }
 apply(candidate:Readonly<SecondaryCalibration>,coordinator:Pick<MotionCoordinator,'calibrateClock'>,ids:readonly string[]):void{
  const token=this.#proposals.get(candidate);
  if(!token||token.revision!==this.#revision||token.main!==this.#main.revision||token.local!==this.#local.revision||!this.#main.active||!this.#local.active)throw new Error('Stale or foreign secondary calibration');
  coordinator.calibrateClock(ids,candidate.offset,candidate.frequency);
  this.#offset=candidate.offset;this.#frequency=candidate.frequency;this.#syncTime=candidate.syncTime;this.#revision++;
 }
}
