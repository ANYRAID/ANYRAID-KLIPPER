import test from 'node:test';
import assert from 'node:assert/strict';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {StepHistory} from '../src/motion/step-history.ts';
test('retention crosses calibration boundaries without losing thirty seconds of pulses',()=>{
 const clock=new PrintClockTimeline({offset:0,frequency:1e6});clock.append(100000000n,900000);
 const observed=109000000n,cutoff=clock.historyCutoff(observed,30)!;
 assert.equal(cutoff,80000000n);assert.equal(observed-BigInt(clock.status.calibration.frequency*30),82000000n);
 const history=new StepHistory(0n,0n);history.append({history:new BigInt64Array([81000000n,81000000n,0n,1n,0n,0n]),position:1n},observed);
 const release=history.pin();history.pruneBefore(cutoff);assert.equal(history.status.fromClock,0n);release();
 history.pruneBefore(cutoff);assert.equal(history.status.rows,1);assert.equal(history.at(80999999n),0n);assert.equal(history.at(81000000n),1n);
 assert.equal(clock.historyCutoff(90000000n,30),60000000n);
});
test('retention rounds down and does not extrapolate before retained clock mappings',()=>{
 const clock=new PrintClockTimeline({offset:0,frequency:1e6});clock.append(100000000n,1000100);
 for(const observed of [100000001n,110000001n,150000001n]){
  const target=clock.printTimeAtClock(observed)-30,cutoff=clock.historyCutoff(observed,30)!;
  assert(clock.printTimeAtClock(cutoff)<=target);assert(clock.printTimeAtClock(cutoff+1n)>target);
 }
 assert.equal(clock.historyCutoff(10000000n,30),undefined);
 clock.retireBefore(100000000n);assert.equal(clock.historyCutoff(110000000n,30),undefined);
 for(const seconds of [-1,Infinity,NaN])assert.throws(()=>clock.historyCutoff(110000000n,seconds));
 assert.throws(()=>clock.historyCutoff(99999999n,30));
});
test('successive calibration segments match native positive half-up rounding',()=>{
 const timeline=new PrintClockTimeline({offset:0,frequency:48e6});
 for(let i=1;i<=50;i++){
  const boundary=BigInt(i)*480000000n;timeline.append(boundary,48e6+(i%2?1200:-1200));
  const mapping=timeline.status.calibration;
  using native=new StepCompressor({frequency:mapping.frequency,timeOffset:mapping.offset,oid:3,maxError:0,queueStepTag:5,directionTag:6});
  for(let j=1;j<=100;j++)for(const fraction of [.499999,.5,.500001]){const time=mapping.offset+(Number(boundary)+j*12345+fraction)/mapping.frequency;assert.equal(timeline.clockAt(time),native.clockAt(time));}
 }
});
test('calibration anchors preserve old samples and new clock continuity across rollover',()=>{
 const timeline=new PrintClockTimeline({offset:0,frequency:1e6}),old=snapshotPrintClock({offset:0,frequency:1e6}),boundary=0x100000000n,time=old.printTimeAtClock(boundary);
 timeline.append(boundary,1000100);
 assert.equal(timeline.clockAt(time),boundary);assert.equal(timeline.printTimeAtClock(boundary),time);
 for(const delta of [1n,20n,1000n,1000000n]){assert.equal(timeline.printTimeAtClock(boundary-delta),old.printTimeAtClock(boundary-delta));assert.equal(timeline.clockAt(time-Number(delta)/1e6),boundary-delta);}
 const next=snapshotPrintClock(timeline.status.calibration);
 for(let i=0;i<10000;i++){const tick=boundary+BigInt(i*12345);assert.equal(timeline.printTimeAtClock(tick),next.printTimeAtClock(tick));assert.equal(timeline.clockAt(next.printTimeAtClock(tick)),tick);}
});
test('bounded history requires explicit retirement and rejects stale reads',()=>{
 const timeline=new PrintClockTimeline({offset:0,frequency:1e6},3);
 timeline.append(1000000n,1000100);timeline.append(2000000n,999900);const old=timeline.status;
 assert.throws(()=>timeline.append(3000000n,1e6),/exhausted/);assert.deepEqual(timeline.status,old);
 timeline.retireBefore(1500000n);assert.equal(timeline.status.fromClock,1000000n);assert.equal(timeline.status.segments,2);
 assert.throws(()=>timeline.printTimeAtClock(999999n));assert.throws(()=>timeline.clockAt(.5));timeline.append(3000000n,1e6);
 assert.equal(timeline.clockAt(timeline.printTimeAtClock(3000000n)),3000000n);
});
test('invalid or numerically inexact updates do not publish a clock segment',()=>{
 const timeline=new PrintClockTimeline({offset:0,frequency:1e6}),before=timeline.status;
 for(const [tick,frequency] of [[0n,1e6],[-1n,1e6],[BigInt(Number.MAX_SAFE_INTEGER)+1n,1e6],[100n,0],[100n,NaN],[100n,Infinity]] as const){assert.throws(()=>timeline.append(tick,frequency));assert.deepEqual(timeline.status,before);}
 for(const tick of [-1n,BigInt(Number.MAX_SAFE_INTEGER)+1n,1 as unknown as bigint])assert.throws(()=>timeline.printTimeAtClock(tick));
 for(const t of [NaN,Infinity,-1])assert.throws(()=>timeline.clockAt(t));
 assert.throws(()=>timeline.retireBefore(-1n));assert.throws(()=>new PrintClockTimeline({offset:0,frequency:1e6},1));
});
