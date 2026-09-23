// Secondary MCU calibration model from klippy/clocksync.py, GPL-3.0-or-later.
import {ClockSync} from './clock-sync.ts';
import {snapshotPrintClock} from './print-clock.ts';
import type {MotionCoordinator} from '../motion/coordinator.ts';
import type {PrintClockTimeline} from './print-clock-timeline.ts';
export interface SecondaryCalibration {readonly offset:number;readonly frequency:number;readonly syncTime:number}
const LIMIT=BigInt(Number.MAX_SAFE_INTEGER);
function exact(clock:bigint):number{if(clock<0n||clock>LIMIT)throw new RangeError('Secondary clock exceeds exact native scheduling range');return Number(clock);}
function time(value:number):void{if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid secondary synchronization time');}
/** Proposals do not change the active mapping. Apply through the motion coordinator
 * only after every emitter on the secondary MCU accepts the calibration. */
export class SecondarySync {
 #main:ClockSync;#local:ClockSync;#offset:number;#frequency:number;#syncTime=0;#revision=0;
 #proposals=new WeakMap<object,{revision:number;main:number;local:number}>();
 #applying=false;
 constructor(main:ClockSync,local:ClockSync,eventTime:number,initial?:Readonly<SecondaryCalibration>){
  time(eventTime);if(main===local)throw new Error('Secondary MCU must differ from primary');this.#main=main;this.#local=local;
  if(initial){const mapping=snapshotPrintClock(initial);time(initial.syncTime);this.#offset=mapping.offset;this.#frequency=mapping.frequency;this.#syncTime=initial.syncTime;return;}
  this.#frequency=local.nominalFrequency;
  this.#offset=exact(main.getClock(eventTime))/main.nominalFrequency-exact(local.getClock(eventTime))/local.nominalFrequency;
  const first=this.propose(0,eventTime);this.#offset=first.offset;this.#frequency=first.frequency;this.#syncTime=first.syncTime;this.#revision++;
 }
 get mapping():SecondaryCalibration{return {offset:this.#offset,frequency:this.#frequency,syncTime:this.#syncTime};}
 /** Independent proposal/revision state, retaining the same physical clocks. */
 fork():SecondarySync{if(this.#applying)throw new Error('Secondary calibration transaction is active');return new SecondarySync(this.#main,this.#local,0,this.mapping);}
 usesClocks(main:ClockSync,local:ClockSync):boolean{return main===this.#main&&local===this.#local;}
 printTimeToClock(printTime:number):bigint{time(printTime);const clock=Math.trunc((printTime-this.#offset)*this.#frequency);if(!Number.isSafeInteger(clock)||clock<0)throw new RangeError('Invalid secondary print clock');return BigInt(clock);}
 clockToPrintTime(clock:bigint):number{const value=exact(clock)/this.#frequency+this.#offset;if(!Number.isFinite(value))throw new RangeError('Secondary time overflow');return value;}
 propose(printTime:number,eventTime:number):Readonly<SecondaryCalibration>{
  if(this.#applying)throw new Error('Secondary calibration transaction is active');
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
 #validate(candidate:Readonly<SecondaryCalibration>):void{
  if(this.#applying)throw new Error('Secondary calibration transaction is active');
  const token=this.#proposals.get(candidate);
  if(!token||token.revision!==this.#revision||token.main!==this.#main.revision||token.local!==this.#local.revision||!this.#main.active||!this.#local.active)throw new Error('Stale or foreign secondary calibration');
 }
 /** Caller supplies a safe generation limit after accounting for every native
  * filter's future source coverage. This only plans; it does not generate. */
 planShared(candidate:Readonly<SecondaryCalibration>,timeline:PrintClockTimeline,coordinator:MotionCoordinator,generationLimit:number){
  this.#validate(candidate);this.#matches(timeline);
  return timeline.planCalibration(coordinator.status.generatedTime,generationLimit,candidate.frequency);
 }
 #matches(timeline:PrintClockTimeline):void{
  const current=timeline.status.calibration;
  if(current.offset!==this.#offset||current.frequency!==this.#frequency)throw new Error('Secondary and shared clock mappings differ');
 }
 /** Publish the estimated slope at the generated boundary, preserving the
  * shared domain's continuity rather than copying a separately rounded offset.
  * Reservations and exact-boundary validation run before any owner changes. */
 applyShared(candidate:Readonly<SecondaryCalibration>,timeline:PrintClockTimeline,coordinator:MotionCoordinator,ids:readonly string[]):void{
  this.#validate(candidate);this.#matches(timeline);
  const tick=timeline.clockAt(coordinator.status.generatedTime);
  this.#applying=true;
  try{
   timeline.calibrateMotion(tick,candidate.frequency,coordinator,ids);
   const applied=timeline.status.calibration;
   this.#offset=applied.offset;this.#frequency=applied.frequency;this.#syncTime=candidate.syncTime;this.#revision++;
  }finally{this.#applying=false;}
 }
 apply(candidate:Readonly<SecondaryCalibration>,coordinator:Pick<MotionCoordinator,'calibrateClock'>,ids:readonly string[]):void{
  this.#validate(candidate);
  this.#applying=true;
  try{coordinator.calibrateClock(ids,candidate.offset,candidate.frequency);
   this.#offset=candidate.offset;this.#frequency=candidate.frequency;this.#syncTime=candidate.syncTime;this.#revision++;
  }finally{this.#applying=false;}
 }
}
