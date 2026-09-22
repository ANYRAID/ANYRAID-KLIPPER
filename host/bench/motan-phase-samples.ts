import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {MotanPhaseSampler,motanPhaseConfig} from '../src/motan/phase-samples.ts';
import {motionCase} from '../test/helpers/motan-motion-oracle.ts';
import {phaseOracle,phaseStatus,phaseSettings} from '../test/helpers/motan-phase-oracle.ts';
const stats=(ms:number[])=>{ms.sort((a,b)=>a-b);return {median:ms[3],p95:ms[6]};};
for(const count of [600,16000]){const input=motionCase(count),reference=phaseOracle(input.blocks,input.times,false,true),ms=[];for(let run=0;run<9;run++){let at=0;const start=performance.now(),sampler=new MotanPhaseSampler(motanPhaseConfig(phaseSettings,'tmc2209 stepper_x'),async()=>input.blocks[at++]??null,phaseStatus),values=[];for(const time of input.times)values.push(await sampler.sample(time));const elapsed=performance.now()-start;assert.deepEqual(values,reference.values);if(run>=2)ms.push(elapsed);}console.log(JSON.stringify({stepsPerBlock:count*2,samples:input.times.length,node:process.version,nodeMs:stats(ms),pythonMs:stats(reference.ms),exact:true}));}
