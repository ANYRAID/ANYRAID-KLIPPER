import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {MotanStepSampler,MotanTrapSampler} from '../src/motan/motion-samples.ts';
import {motionCase,oracle,sourceHash} from '../test/helpers/motan-motion-oracle.ts';
const stats=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {median:sorted[Math.floor(sorted.length/2)],p95:sorted[Math.ceil(sorted.length*.95)-1]};};
console.log(JSON.stringify({node:process.version,sourceHash,warmup:2,measured:7}));
for(const count of [600,16000]){
 const input=motionCase(count),reference=oracle(input,true),times:number[]=[];let worstSyncBlock=0;
 for(let run=0;run<9;run++){let b=0,m=0;const step=new MotanStepSampler(async()=>input.blocks[b++]??null),trap=new MotanTrapSampler('x',async()=>input.moves[m++]??null);const a=[],c=[],start=performance.now();for(const time of input.times){a.push(await step.sample(time));c.push(await trap.sample(time));}const elapsed=performance.now()-start;assert.deepEqual(a,reference.step);assert.deepEqual(c,reference.trap);if(run>=2)times.push(elapsed);}
 {let b=0,m=0;const step=new MotanStepSampler(async()=>input.blocks[b++]??null),trap=new MotanTrapSampler('x',async()=>input.moves[m++]??null);for(const time of input.times){const start=performance.now();await step.sample(time);await trap.sample(time);worstSyncBlock=Math.max(worstSyncBlock,performance.now()-start);}}
 console.log(JSON.stringify({stepsPerBlock:count*2,samplesPerDataset:input.times.length,node:stats(times),python:stats(reference.ms),maxSamplePairMs:worstSyncBlock,maxAbsoluteError:0}));
}
