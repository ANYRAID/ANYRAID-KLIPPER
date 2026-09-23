import {snapshotPrintClock} from './print-clock.ts';
import type {MotionCoordinator} from '../motion/coordinator.ts';
type Clock=ReturnType<typeof snapshotPrintClock>;
type Segment={tick:bigint;time:number;clock:Clock};
export interface ClockHistoryLease {advance(tick:bigint):void;release():void;}
/** A read-only conversion view; reservations belong to actual runtime writers. */
export function readPrintClock(calibration:Readonly<{offset:number;frequency:number}>,timeline?:PrintClockTimeline){
 const fixed=snapshotPrintClock(calibration);if(!timeline)return fixed;
 const current=timeline.status.calibration;if(current.offset!==fixed.offset||current.frequency!==fixed.frequency)throw new Error('Shared clock calibration differs');
 return Object.freeze({get offset(){return timeline.status.calibration.offset;},get frequency(){return timeline.status.calibration.frequency;},clockAt:(time:number)=>timeline.clockAt(time),printTimeAtClock:(tick:bigint)=>timeline.printTimeAtClock(tick)});
}
/** Piecewise clock mappings for future scheduling and delayed MCU samples.
 * Updates anchor at an exact MCU tick, preserving continuity. Caller must put
 * the boundary after all committed output and motion; this class owns no IO.
 * Retire only after every timestamp consumer has released older samples. */
export class PrintClockTimeline {
 #segments:Segment[];#capacity:number;#reservedThrough=0n;
 #updating=false;
 #writable():void{if(this.#updating)throw new Error('Clock calibration transaction is active');}
 #readers=new Map<symbol,bigint>();
 retain(tick=this.#segments[0].tick):ClockHistoryLease{
  this.#writable();
  this.printTimeAtClock(tick);if(this.#readers.size>=1024)throw new Error('Clock history reader limit exceeded');
  const id=Symbol();this.#readers.set(id,tick);
  return Object.freeze({advance:(next:bigint)=>{const prior=this.#readers.get(id);if(prior===undefined)throw new Error('Clock history lease released');this.printTimeAtClock(next);if(next<prior)throw new RangeError('Clock history reader cannot rewind');this.#readers.set(id,next);},release:()=>{this.#readers.delete(id);}});
 }
 constructor(calibration:Readonly<{offset:number;frequency:number}>,capacity=1024){
  if(!Number.isSafeInteger(capacity)||capacity<2||capacity>65536)throw new RangeError('Invalid clock history capacity');
  const clock=snapshotPrintClock(calibration);this.#segments=[{tick:0n,time:clock.printTimeAtClock(0n),clock}];this.#capacity=capacity;
 }
 get status(){const last=this.#segments.at(-1)!;return {segments:this.#segments.length,fromClock:this.#segments[0].tick,latestClock:last.tick,reservedThrough:this.#reservedThrough,calibration:{offset:last.clock.offset,frequency:last.clock.frequency}};}
 /** Reserve before encoding/enqueuing a timed command. A failed send or reset
  * does not release this conservative fence shared by all MCU writers. */
 reserve(time:number):bigint{this.#writable();const tick=this.clockAt(time);if(tick>this.#reservedThrough)this.#reservedThrough=tick;return tick;}
 /** Already encoded configuration/motion commands can reserve exact ticks. */
 reserveClock(tick:bigint):void{this.#writable();this.printTimeAtClock(tick);if(tick>this.#reservedThrough)this.#reservedThrough=tick;}
 #index(before:(s:Segment)=>boolean):number{let low=0,high=this.#segments.length;while(low<high){const middle=(low+high)>>>1;if(before(this.#segments[middle]))high=middle;else low=middle+1;}return low-1;}
 clockAt(time:number):bigint{
  if(!Number.isFinite(time)||time<this.#segments[0].time)throw new RangeError('Print time outside retained clock history');
  const index=this.#index(s=>time<s.time);return this.#segments[index].clock.clockAt(time);
 }
 printTimeAtClock(tick:bigint):number{
  if(typeof tick!=='bigint'||tick<this.#segments[0].tick||tick>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('MCU tick outside retained clock history');
  return this.#segments[this.#index(s=>tick<s.tick)].clock.printTimeAtClock(tick);
 }
 /** Conservative retention watermark in elapsed print seconds. If the target
  * predates available mappings, leave history intact instead of extrapolating. */
 historyCutoff(observed:bigint,seconds:number):bigint|undefined{
  if(!Number.isFinite(seconds)||seconds<0)throw new RangeError('Invalid history retention duration');
  const time=this.printTimeAtClock(observed),target=time-seconds;
  if(seconds>0&&target>=time)throw new RangeError('History duration below print-time resolution');
  if(target<this.#segments[0].time)return undefined;
  const tick=this.clockAt(target);return this.printTimeAtClock(tick)>target?tick-1n:tick;
 }
 /** No mutation on validation failure. Capacity exhaustion requires explicit
  * consumer retirement, never automatic loss of ADC/history timestamps. */
 append(tick:bigint,frequency:number):void{
  this.#writable();this.#segments.push(this.#candidate(tick,frequency));
 }
 /** All selected emitters must have generated exactly through the boundary.
  * Caller must select the complete MCU group. No asynchronous work is allowed. */
 calibrateMotion(tick:bigint,frequency:number,coordinator:MotionCoordinator,ids:readonly string[]):void{
  this.#writable();const next=this.#candidate(tick,frequency),previous=this.#segments.at(-1)!.clock;
  this.#updating=true;
  try{coordinator.calibrateClockAtBoundary(ids,previous,next.clock,next.time);this.#segments.push(next);}finally{this.#updating=false;}
 }
 #candidate(tick:bigint,frequency:number):Segment{
  const last=this.#segments.at(-1)!;
  if(typeof tick!=='bigint'||tick<=last.tick||tick<=this.#reservedThrough||tick>BigInt(Number.MAX_SAFE_INTEGER)||this.#segments.length>=this.#capacity)throw new RangeError('Invalid clock boundary, reserved output or exhausted history');
  const time=last.clock.printTimeAtClock(tick),clock=snapshotPrintClock({offset:time-Number(tick)/frequency,frequency});
  if(time<=last.time||clock.clockAt(time)!==tick||clock.printTimeAtClock(tick)!==time)throw new RangeError('Clock boundary exceeds exact mapping resolution');
  return {tick,time,clock};
 }
 /** Retain the segment containing this watermark, including its earlier tail. */
 retireBefore(tick:bigint):void{
  this.#writable();
  if(typeof tick!=='bigint'||tick<this.#segments[0].tick||tick>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid clock history watermark');
  for(const retained of this.#readers.values())if(retained<tick)tick=retained;
  const index=this.#index(s=>tick<s.tick);if(index>0)this.#segments.splice(0,index);
 }
}
