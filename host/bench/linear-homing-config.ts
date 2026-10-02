import assert from 'node:assert/strict';
import {initialLinearFixture} from '../test/helpers/initial-linear.ts';
import {compileLinearHoming} from '../src/config/linear-homing.ts';
const f=await initialLinearFixture(true),times:number[]=[],cpu:number[]=[];
try{
 const before=f.firmware.map(fw=>fw.outputs.length);
 for(let run=0;run<14;run++){
  const used=process.cpuUsage(),start=performance.now();
  for(let i=0;i<1000;i++){
   const plan=compileLinearHoming(f.hardware.plan,f.initial.generation,f.configuredSettings);
   assert.equal(plan.groupsByAxis[0][0].members[0].physicalMember,0);assert.strictEqual(plan.groupsByAxis[2][0].endstop,f.hardware.plan.homing[2].endstop);assert.deepEqual(plan.groupsByAxis[0][0].members[0].emitters,['x','y','z','e']);
  }
  const elapsed=(performance.now()-start)/1000,usage=process.cpuUsage(used);if(run>=3){times.push(elapsed);cpu.push((usage.user+usage.system)/1e6);}
 }
 assert.deepEqual(f.firmware.map(fw=>fw.outputs.length),before);assert.equal(f.firmware[0].motion.length,0);
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=stats(times),usage=stats(cpu);
 console.log(JSON.stringify({node:process.version,warmup:3,samples:11,compilationsPerSample:1000,timing,cpu:usage,scope:'Per compilation of all three axes and XYZE stop ownership, includes result checks; no IO or native allocation. Cold configuration budget, not print throughput.'}));
 assert(timing.p95Ms<.25,'Homing compilation exceeds 0.25 ms startup budget');
}finally{await f.hardware.close();await f.close();}
