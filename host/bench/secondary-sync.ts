import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {clockBenchmarkReference,clockBenchmarkReferenceIdentity} from '../test/helpers/clock-benchmark-reference.ts';
import {ClockSync} from '../src/timing/clock-sync.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
const samples=Array.from({length:5000},(_,index)=>{const i=index+1,t=i*.9839;return {main:{clock32:Math.trunc(t*(64000000+125))>>>0,sentTime:i%53?10+t-(i%17===0?.02:0):0,receiveTime:10+t+.002+(i%7)*.0001},local:{clock32:Math.trunc(t*(48000000-80))>>>0,sentTime:i%67?10+t:0,receiveTime:10+t+.003+(i%5)*.0001},printTime:t+(i%7)*.2,eventTime:10+t+.005};});
const oracle=clockBenchmarkReference<{results:[number,number,number,string][];times:number[]}>('secondary-sync',JSON.stringify(samples));
let maxOffsetError=0,maxClockError=0,maxFrequencyError=0,maxSyncTimeError=0;const sink={calibrateClock(){}};
function run(compare=false){const main=new ClockSync(64000000,0n,10),local=new ClockSync(48000000,0n,10),sync=new SecondarySync(main,local,10);
 samples.forEach((sample,i)=>{main.accept(sample.main,i<8);local.accept(sample.local,i<8);const candidate=sync.propose(sample.printTime,sample.eventTime);sync.apply(candidate,sink,['secondary']);if(compare){const expected=oracle.results[i];maxOffsetError=Math.max(maxOffsetError,Math.abs(candidate.offset-expected[0]));maxClockError=Math.max(maxClockError,Math.abs(Number(sync.printTimeToClock(sample.printTime+.5)-BigInt(expected[3]))));maxFrequencyError=Math.max(maxFrequencyError,Math.abs(candidate.frequency-expected[1]));maxSyncTimeError=Math.max(maxSyncTimeError,Math.abs(candidate.syncTime-expected[2]));}});
}
run(true);assert.equal(maxOffsetError,0);assert(maxClockError===0,`Clock error ${maxClockError}`);assert(maxFrequencyError===0,`Frequency error ${maxFrequencyError}`);assert(maxSyncTimeError===0,`Horizon error ${maxSyncTimeError}`);
for(let i=0;i<3;i++)run();const times=[];for(let i=0;i<11;i++){const t=performance.now();run();times.push(performance.now()-t);}const rawNodeTimes=[...times];times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,samples:samples.length,maxOffsetError,maxClockError,maxFrequencyError,maxSyncTimeError,nodeMedianMs:times[5],nodeP95Ms:times[10],historicalPythonMedianMs:oracle.times[5],historicalPythonP95Ms:oracle.times[10],historicalRatio:oracle.times[5]/times[5],rawNodeTimes,reference:clockBenchmarkReferenceIdentity},null,2));
