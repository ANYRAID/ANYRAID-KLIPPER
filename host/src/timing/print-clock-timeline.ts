import {snapshotPrintClock} from './print-clock.ts';
type Clock=ReturnType<typeof snapshotPrintClock>;
type Segment={tick:bigint;time:number;clock:Clock};
/** Piecewise clock mappings for future scheduling and delayed MCU samples.
 * Updates anchor at an exact MCU tick, preserving continuity. Caller must put
 * the boundary after all committed output and motion; this class owns no IO.
 * Retire only after every timestamp consumer has released older samples. */
export class PrintClockTimeline {
 #segments:Segment[];#capacity:number;
 constructor(calibration:Readonly<{offset:number;frequency:number}>,capacity=1024){
  if(!Number.isSafeInteger(capacity)||capacity<2||capacity>65536)throw new RangeError('Invalid clock history capacity');
  const clock=snapshotPrintClock(calibration);this.#segments=[{tick:0n,time:clock.printTimeAtClock(0n),clock}];this.#capacity=capacity;
 }
 get status(){const last=this.#segments.at(-1)!;return {segments:this.#segments.length,fromClock:this.#segments[0].tick,latestClock:last.tick,calibration:{offset:last.clock.offset,frequency:last.clock.frequency}};}
 #index(before:(s:Segment)=>boolean):number{let low=0,high=this.#segments.length;while(low<high){const middle=(low+high)>>>1;if(before(this.#segments[middle]))high=middle;else low=middle+1;}return low-1;}
 clockAt(time:number):bigint{
  if(!Number.isFinite(time)||time<this.#segments[0].time)throw new RangeError('Print time outside retained clock history');
  const index=this.#index(s=>time<s.time);return this.#segments[index].clock.clockAt(time);
 }
 printTimeAtClock(tick:bigint):number{
  if(typeof tick!=='bigint'||tick<this.#segments[0].tick||tick>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('MCU tick outside retained clock history');
  return this.#segments[this.#index(s=>tick<s.tick)].clock.printTimeAtClock(tick);
 }
 /** No mutation on validation failure. Capacity exhaustion requires explicit
  * consumer retirement, never automatic loss of ADC/history timestamps. */
 append(tick:bigint,frequency:number):void{
  const last=this.#segments.at(-1)!;
  if(typeof tick!=='bigint'||tick<=last.tick||tick>BigInt(Number.MAX_SAFE_INTEGER)||this.#segments.length>=this.#capacity)throw new RangeError('Invalid clock boundary or exhausted history');
  const time=last.clock.printTimeAtClock(tick),clock=snapshotPrintClock({offset:time-Number(tick)/frequency,frequency});
  if(time<=last.time||clock.clockAt(time)!==tick||clock.printTimeAtClock(tick)!==time)throw new RangeError('Clock boundary exceeds exact mapping resolution');
  this.#segments.push({tick,time,clock});
 }
 /** Retain the segment containing this watermark, including its earlier tail. */
 retireBefore(tick:bigint):void{
  if(typeof tick!=='bigint'||tick<this.#segments[0].tick||tick>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid clock history watermark');
  const index=this.#index(s=>tick<s.tick);if(index>0)this.#segments.splice(0,index);
 }
}
