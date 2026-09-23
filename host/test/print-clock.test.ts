import test from 'node:test';
import assert from 'node:assert/strict';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
import {StepCompressor} from '../src/motion/step-compressor.ts';
for(const [offset,frequency] of [[0,1e6],[-.123,999999.75],[123456.125,48e6]])test(`peripheral clock preserves native rounding and inverse mapping (${offset}, ${frequency})`,()=>{
 using s=new StepCompressor({frequency,timeOffset:offset,oid:3,maxError:0,queueStepTag:5,directionTag:6});const clock=snapshotPrintClock(s.calibration);
 for(let i=0;i<10000;i++)for(const fraction of [.499999,.5,.500001]){const time=offset+(i*12345+fraction)/frequency;assert.equal(clock.clockAt(time),s.clockAt(time));}
 for(const tick of [0n,1n,0xffffffffn,0x100000000n,BigInt(Number.MAX_SAFE_INTEGER)])assert.equal(clock.printTimeAtClock(tick),s.printTimeAtClock(tick));
 for(const time of [NaN,Infinity,offset-1,offset+Number.MAX_SAFE_INTEGER/frequency*2]){assert.throws(()=>clock.clockAt(time));assert.throws(()=>s.clockAt(time));}
});
test('peripheral clock owns its calibration and remains valid after solver disposal',()=>{
 const s=new StepCompressor({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6}),calibration={...s.calibration},clock=snapshotPrintClock(calibration);
 calibration.frequency=2e6;s.dispose();assert(Object.isFrozen(clock));assert.equal(clock.clockAt(.0000005),1n);assert.equal(clock.clockAt(2),2000000n);assert.equal(clock.printTimeAtClock(2000000n),2);
 for(const tick of [-1n,BigInt(Number.MAX_SAFE_INTEGER)+1n,1 as unknown as bigint])assert.throws(()=>clock.printTimeAtClock(tick));
 for(const bad of [{offset:NaN,frequency:1},{offset:1e15,frequency:1},{offset:0,frequency:0},{offset:0,frequency:Infinity},{offset:0,frequency:1e10}])assert.throws(()=>snapshotPrintClock(bad));
});
