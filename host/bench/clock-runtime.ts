import {performance} from 'node:perf_hooks';
import {cpus} from 'node:os';
import assert from 'node:assert/strict';
import {ClockRuntime} from '../src/timing/clock-runtime.ts';
import type {ClockSample,ReleaseEstimate} from '../src/timing/clock-sync.ts';
import {FakeClock} from '../test/helpers/clock-scheduler.ts';
import {clockRuntimeReference,clockRuntimeReferenceSha256} from '../test/helpers/clock-runtime-reference.ts';
const count=5000;
async function run(capture=false){const clock=new FakeClock(),samples:ClockSample[]=[],estimates:ReleaseEstimate[]=[];let replies=0;
 const runtime=new ClockRuntime(1e6,{async uptime(){return {high:0,clock32:1000000,sentTime:clock.time,receiveTime:clock.time};},async queryClock(){replies++;const sample={clock32:Math.round(1000000+(clock.time-10)*1e6)>>>0,sentTime:replies===8?0:clock.time,receiveTime:clock.time};if(capture)samples.push(sample);return sample;},setClockEstimate(e){if(capture)estimates.push(e);},async stop(){}},clock);
 const start=runtime.start();await clock.advance(.41);await start;const times=[];
 for(let i=0;i<count;i++){const before=performance.now();await clock.advance(.9839);runtime.assertActive();times.push(performance.now()-before);}
 assert.equal(replies,count+9);await runtime.stop();assert.equal(clock.pending,0);const rawTimes=[...times];times.sort((a,b)=>a-b);return {samples,estimates,rawTimes,median:times[Math.floor(count*.5)],p95:times[Math.floor(count*.95)],max:times[count-1]};
}
const actual=await run(true);let maxClockError=0,maxFrequencyError=0;
const expected=clockRuntimeReference(JSON.stringify(actual.samples));assert.equal(actual.estimates.length,expected.length);
 actual.estimates.forEach((e,i)=>{maxClockError=Math.max(maxClockError,Math.abs(Number(e.clock-BigInt(expected[i][2]))));maxFrequencyError=Math.max(maxFrequencyError,Math.abs(e.frequency-expected[i][0]));assert.equal(e.sampleTime,expected[i][1]);});assert(maxClockError<=1);assert(maxFrequencyError<1e-5);
const warm=await run();
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,steadyQueries:count,estimatesCompared:actual.estimates.length,maxClockError,maxFrequencyError,callbackMedianMs:warm.median,callbackP95Ms:warm.p95,callbackMaxMs:warm.max,periodMs:983.9,reference:{kind:'frozen independent Python numerical reference',capturedAt:'2026-10-07',sha256:clockRuntimeReferenceSha256},rawSamplesMs:{capturing:actual.rawTimes,steady:warm.rawTimes},scope:'Includes fake scheduler and promise draining; no live Python, wire latency or hardware acceptance'},null,2));
