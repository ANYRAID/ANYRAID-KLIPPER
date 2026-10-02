import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {planHomingGroups,type HomingGroupConfig} from '../src/homing/group-plan.ts';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
for(const independent of [false,true]){
 const samples:number[]=[],cpu:number[]=[];
 for(let round=0;round<14;round++){
  const f=await rebuiltFixture(true);try{
   const g=await bindRebuiltMotion(f.options),k=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
   const p=await prepareHomingTrajectory(g,k,[51,0,0,2],10,0,new AbortController().signal);
   const configs:HomingGroupConfig[]=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:independent?['x','e']:['x','e','x2']}],primary:0,endstop:f.endstop,expireTimeout:.25}];
   if(independent)configs.push({members:[{physicalMember:0,trigger:f.secondTrigger,emitters:['x2']}],primary:0,endstop:f.secondEndstop,expireTimeout:.25});
   const before=f.fw.outputs.length,used=process.cpuUsage(),start=performance.now();
   for(let i=0;i<200;i++){const plan=planHomingGroups(g,f.emitters,p,configs);assert.equal(plan.emitters.length,3);assert.equal(plan.histories[2].member,independent?1:0);assert(plan.groups.every(g=>g.sampling.restTicks===1000n));}
   const elapsed=performance.now()-start,usage=process.cpuUsage(used);assert.equal(f.fw.outputs.length,before);assert.equal(f.stops,0);if(round>=3){samples.push(elapsed);cpu.push((usage.user+usage.system)/1000);}
  }finally{await f.close();}
 }
 for(const s of [samples,cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
 console.log(JSON.stringify({node:process.version,independent,plans:200,samples:11,elapsed:stats(samples),cpu:stats(cpu),scope:'group ownership validation, native endstop rate, sampling encoding and logical/physical map construction; setup excluded; no arming or real movement'}));
 assert(samples[5]<25,'200 group plans exceed 25ms desktop median budget');assert(cpu[5]<25,'200 group plans exceed 25ms desktop CPU budget');
}
