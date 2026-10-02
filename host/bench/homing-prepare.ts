import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {inputShaper} from '../src/motion/shaper.ts';
for(const filtered of [false,true]){
 const samples:number[]=[],cpu:number[]=[];
 for(let round=0;round<14;round++){
  const f=await rebuiltFixture();try{
   const g=await bindRebuiltMotion(f.options),k=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
   if(filtered){g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});g.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
   const used=process.cpuUsage(),start=performance.now(),p=await prepareHomingTrajectory(g,k,[51,0,0,2],10,0,new AbortController().signal),elapsed=performance.now()-start,usage=process.cpuUsage(used);
   assert.equal(f.fw.motion.length,0);assert.equal(g.source.status.retired,true);assert(p.movementStart>p.startTime);assert(p.sourceUntil>p.endTime);assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,100n);assert.equal(f.stops,0);
   if(round>=3){samples.push(elapsed);cpu.push((usage.user+usage.system)/1000);}
  }finally{await f.close();}
 }
 for(const s of [samples,cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
 console.log(JSON.stringify({node:process.version,filtered,samples:11,elapsed:stats(samples),cpu:stats(cpu),scope:'privileged planning, producer handoff, native source padding and baseline history preparation; setup excluded; no step generation or printer movement'}));
 assert(samples[5]<1,'Seek preparation median exceeds 1ms desktop budget');assert(cpu[5]<1,'Seek preparation CPU median exceeds 1ms desktop budget');
}
