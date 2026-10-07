import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {clockBenchmarkReference,clockBenchmarkReferenceIdentity} from '../test/helpers/clock-benchmark-reference.ts';
import {ClockSync} from '../src/timing/clock-sync.ts';
const frequency=64000000;
const mode=process.env.CLOCK_SAMPLE_MODE??'periodic';
if(!['periodic','demand'].includes(mode))throw new Error('Invalid clock sample mode');
let elapsed=0;
const samples=Array.from({length:5000},(_,index)=>{
  const i=index+1,time=mode==='periodic'?i*.9839:(elapsed+=i%100<80?.05:.9839);
  return {clock32:Math.trunc(time*(frequency+125))>>>0,sentTime:i%53===0?0:10+time-(i%17===0?.02:0),receiveTime:10+time+.002+(i%7)*.0001};
});
const oracle=clockBenchmarkReference<{results:{release:[number,number,number]|null;clock:number;last:number;estimate:number[]}[];times:number[]}>('clock-sync-'+mode,JSON.stringify(samples));
let maxFrequencyError=0,maxClockError=0,accepted=0;
function run(compare=false):void {
  const sync=new ClockSync(frequency,0n,10);
  samples.forEach((sample,i)=>{
    const release=sync.accept(sample,i<8);
    if(!compare) return;
    const expected=oracle.results[i];
    assert.equal(release===null,expected.release===null);
    assert.equal(sync.lastClock,BigInt(expected.last));
    const clockError=Math.abs(Number(sync.getClock(sample.receiveTime+.25))-expected.clock);
    maxClockError=Math.max(maxClockError,clockError);assert.ok(clockError<=1);
    if(release) {
      assert.ok(expected.release);
      accepted++;
      maxFrequencyError=Math.max(maxFrequencyError,Math.abs(release.frequency-expected.release[0]));
      assert.ok(Math.abs(release.frequency-expected.release[0])<1e-6);
      assert.equal(release.clock,BigInt(expected.release[2]));
      assert.equal(release.sampleTime,expected.release[1]);
    }
  });
}
run(true);for(let i=0;i<3;i++) run();
const times=[];
for(let i=0;i<11;i++) {const start=performance.now();run();times.push(performance.now()-start);}
const rawNodeTimes=[...times];times.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,mode,samples:samples.length,accepted,maxFrequencyError,maxClockError,nodeMedianMs:times[5],historicalPythonMedianMs:oracle.times[5],nodeP95Ms:times[10],historicalPythonP95Ms:oracle.times[10],historicalRatio:oracle.times[5]/times[5],rawNodeTimes,reference:clockBenchmarkReferenceIdentity},null,2));
assert.ok(times[5]<=oracle.times[5],'Clock estimation exceeded the captured Python desktop baseline (historical reference)');
