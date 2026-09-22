import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MotanSensorSampler,motanAngleScale} from '../src/motan/sensor-samples.ts';
import {sensorCase,sensorOracle} from '../test/helpers/motan-sensor-oracle.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(const selection of ['x','angle','period','counts'] as const){const input=sensorCase(selection,8000),reference=sensorOracle(input,true),ms=[];for(let run=0;run<9;run++){let at=0;const values=[],start=performance.now(),sampler=new MotanSensorSampler(selection,async()=>input.blocks[at++]??null,motanAngleScale(input.settings,'s'));for(const time of input.times)values.push(await sampler.sample(time));const elapsed=performance.now()-start;assert.deepEqual(values,reference.values);if(run>=2)ms.push(elapsed);}console.log(JSON.stringify({selection,node:process.version,rows:32000,samples:input.times.length,nodeMs:stats(ms),pythonMs:stats(reference.ms),maxAbsoluteError:0}));}
