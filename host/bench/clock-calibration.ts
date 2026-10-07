import {cpus} from 'node:os';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {clockBenchmarkReference,clockBenchmarkReferenceIdentity} from '../test/helpers/clock-benchmark-reference.ts';
import {StepCompressor} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
const fixtures=[0,1,2,3].map(kind=>{
 const initialClock=kind===2?2**32-1000:kind===3?2**40:0;let time=initialClock/1e6+.001;
 const rows=[];for(let i=0;i<(kind===0?20000:2000);i++){time+=(kind===1?.0001:.0008)+i%71*.000001;rows.push(Math.floor(i/(kind===1?1:500))%2,time,0);}
 return {initialClock,rows};
});
const oracle=clockBenchmarkReference<{results:unknown[];times:number[]}>('clock-calibration',JSON.stringify(fixtures));
 const arrays=fixtures.map(f=>new Float64Array(f.rows));
 const run=(i:number)=>{using c=new StepCompressor({...settings,initialClock:BigInt(fixtures[i].initialClock)});const results=[];let clockOffset=0,frequency=1e6;
 const capture=(r:ReturnType<StepCompressor['flush']>)=>({messages:r.messages.map(m=>[m.data.toString('hex'),String(m.minClock),String(m.reqClock)]),history:[...r.history].map(String),position:String(r.position)});
 for(let offset=0;offset<arrays[i].length;offset+=600){const rows=arrays[i].subarray(offset,offset+600);c.append(rows);const anchor=rows[rows.length-2],target=(anchor-clockOffset)*frequency+2;frequency=1e6+((offset/600)%2?100:-100);clockOffset=anchor-target/frequency;c.calibrateClock(clockOffset,frequency);results.push(capture(c.flushThrough(Math.max(fixtures[i].initialClock/1e6,rows[rows.length-2]-.002))));}
 results.push(capture(c.flush()));return results;};
 fixtures.forEach((_,i)=>assert.deepEqual(run(i),oracle.results[i]));
 for(let i=0;i<3;i++)run(0);const times=[];for(let i=0;i<11;i++){const t=performance.now();run(0);times.push(performance.now()-t);}const rawNodeTimes=[...times];times.sort((a,b)=>a-b);
 console.log(JSON.stringify({node:process.version,cpu:cpus()[0].model,fixtures:fixtures.length,packetAndHistoryExact:true,steps:20000,nodeMedianMs:times[5],nodeP95Ms:times[10],historicalPythonMedianMs:oracle.times[5],historicalPythonP95Ms:oracle.times[10],historicalRatio:oracle.times[5]/times[5],rawNodeTimes,reference:clockBenchmarkReferenceIdentity},null,2));
