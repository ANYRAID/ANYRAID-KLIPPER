import assert from 'node:assert/strict';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {hardwareFixture,hardwareReader,hardwareLayout,hardwareClocks} from '../test/helpers/configured-hardware.ts';
const reader=hardwareReader(),clocks=hardwareClocks(),wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const start=performance.now(),used=process.cpuUsage();
 for(let i=0;i<500;i++){
  const f=hardwareFixture(),p=compileConfiguredHardware(reader,f.group,clocks,hardwareLayout);
  assert.deepEqual(p.configurations.map(c=>c.plan.oidCount),[4,5]);assert.deepEqual(p.configurations.map(c=>c.plan.reservedMoves),[1,3]);assert.equal(p.steppers[0].stepDistance,.0125);
 }
 const elapsed=(performance.now()-start)/500,usage=process.cpuUsage(used);if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/500000);}
}
const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,batchesPerSample:500,wall:timing,cpu:usage,scope:'Fresh dictionary and private resource registry; two MCU plans, stepper, enable, endstop, two triggers, fan with enable, heater with ADC. Planning only; no MCU IO.'}));
assert(timing.medianMs<3&&usage.medianMs<3,'Two-MCU hardware planning exceeded 3 ms startup budget');
