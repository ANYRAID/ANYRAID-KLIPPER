import assert from 'node:assert/strict';
import {initialMotionFixture,initialMotionOptions} from '../test/helpers/initial-motion.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
const wall:number[]=[],cpu:number[]=[];
for(let run=0;run<14;run++){
 const f=await initialMotionFixture(!!(run%2));try{
  f.firmware[0].setStepperPosition(0,123);
  const used=process.cpuUsage(),start=performance.now();
  const initial=await initializeConfiguredMotion(f.hardware,{...initialMotionOptions,fanSection:'fan'},f.signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used);
  assert.equal(initial.generation.motion.bindings[0].history.status.lastPlannedPosition,123n);assert.equal(f.firmware[0].motion.length,0);assert.equal(f.firmware[1].motion.length,0);
  if(run>=3){wall.push(elapsed);cpu.push((usage.user+usage.system)/1000);}
  await initial.close();
 }finally{await f.close();}
}
const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[5],p95Ms:a[10]};},timing=stats(wall),usage=stats(cpu);
console.log(JSON.stringify({node:process.version,samples:11,warmup:3,timing,cpu:usage,scope:'Initial stop confirmation, real counter reads, native allocation, reset ACK and auxiliary fan binding on two native MCU emulators. Excludes connection/configuration and shutdown. Startup budget, not a comparative throughput claim.'}));
assert(timing.p95Ms<100,'Initial motion exceeds 100 ms startup budget');
assert(usage.p95Ms<50,'Initial motion exceeds 50 ms CPU budget');
