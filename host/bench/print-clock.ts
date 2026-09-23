import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {snapshotPrintClock} from '../src/timing/print-clock.ts';
using stepper=new StepCompressor({frequency:999999.75,timeOffset:-.123,oid:3,maxError:0,queueStepTag:5,directionTag:6});
const clock=snapshotPrintClock(stepper.calibration),n=100000,times=Float64Array.from({length:n},(_,i)=>i*.001+.0000005),ticks=Array.from(times,t=>stepper.clockAt(t));
for(let i=0;i<n;i++){assert.equal(clock.clockAt(times[i]),ticks[i]);assert.equal(clock.printTimeAtClock(ticks[i]),stepper.printTimeAtClock(ticks[i]));}
const samples:number[][]=[[],[]];let expected:bigint|undefined;
for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){const mapping=variant?clock:stepper,begin=performance.now();let result=0n;for(let i=0;i<n;i++)result+=mapping.clockAt(mapping.printTimeAtClock(ticks[i]));const elapsed=performance.now()-begin;if(expected===undefined)expected=result;else assert.equal(result,expected);if(run>=3)samples[variant].push(elapsed);}
const stats=samples.map(a=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};});console.log(JSON.stringify({node:process.version,conversions:n*2,samples:11,variants:['stepperMapping','immutableMapping'],stats,maxTickError:0}));assert(stats[1].medianMs<=stats[0].medianMs*1.3+2,'Immutable mapping slowed hot clock conversion');
