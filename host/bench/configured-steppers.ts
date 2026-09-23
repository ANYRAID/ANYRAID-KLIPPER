import assert from 'node:assert/strict';
import {stepperBatchFixture,batchReader} from '../test/helpers/configured-steppers.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
const reader=batchReader(),wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const used=process.cpuUsage(),start=performance.now();
 for(let i=0;i<500;i++){const f=stepperBatchFixture(),plans=compileConfiguredSteppers(reader,f.pins,f.mcus,[{section:'stepper_x',oid:1},{section:'stepper_y',oid:2}]);assert.equal(plans.length,2);assert.equal(plans[0].stepDistance,.0125);assert.equal(f.pins.claimedPins.length,4);}
 const time=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(time);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,steppersPerBatch:2,wallPerBatch:timing,cpuPerBatch:usage,scope:'Fresh firmware dictionary/pin registry plus validated atomic stepper plans; no MCU IO or physical movement.'}));assert(timing.medianMs<2,'Two-stepper startup planning exceeded 2 ms per batch');
