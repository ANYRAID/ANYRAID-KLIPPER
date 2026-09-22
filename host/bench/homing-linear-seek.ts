import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
import {planHomingGroups} from '../src/homing/group-plan.ts';
import {HomingMoveExecution} from '../src/homing/move-execution.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const elapsed:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let round=0;round<14;round++)for(const managed of round%2?[1,0]:[0,1]){
 const f=await rebuiltFixture(false,true);let recovered:Awaited<ReturnType<HomingMoveExecution['run']>>['motion']|undefined;
 try{
  const generation=await bindRebuiltMotion(f.options),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100}),signal=new AbortController().signal;
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);
  const used=process.cpuUsage(),start=performance.now();
  if(managed){const result=await new LinearHomingSeek({generation,kinematics,groups,emitters:f.emitters,kinematicIds:['x','y','z']}).run([51,0,0,2],10,0,signal);recovered=result.motion;assert.deepEqual(result.position,[51,0,0,2]);}
  else{
   const p=await prepareHomingTrajectory(generation,kinematics,[51,0,0,2],10,0,signal),plan=planHomingGroups(generation,f.emitters,p,groups);
   using move=new HomingMoveExecution({...plan,coordinator:generation.coordinator,bindings:generation.motion.bindings,startTime:p.startTime,endTime:p.endTime,locate:()=>({queues:[{id:'xyz',position:[51,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(f.options.members[0].session.clock.sync.getClock(serialClock.now()))/1e6+.2})});
   const result=await move.run(signal);recovered=plan.restorePhysicalMembers(result.motion);
   await bindRebuiltMotion({...f.options,motion:recovered,routes:[{queue:recovered.bindings[0].queue},{queue:recovered.bindings[1].queue,extrusionAxis:3}],position:[51,0,0,2]});
  }
  const ms=performance.now()-start,usage=process.cpuUsage(used);assert.equal(recovered.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.stops,0);assert.equal(kinematics.status.homedAxes,'');
  if(round>=3){elapsed[managed].push(ms);cpu[managed].push((usage.user+usage.system)/1000);}
 }finally{await f.options.group.stop();recovered?.dispose();await f.close();}
}
for(const s of [...elapsed,...cpu])s.sort((a,b)=>a-b);const stats=(s:number[])=>({medianMs:s[5],p95Ms:s[10]});
console.log(JSON.stringify({node:process.version,samples:11,manual:{elapsed:stats(elapsed[0]),cpu:stats(cpu[0])},managed:{elapsed:stats(elapsed[1]),cpu:stats(cpu[1])},scope:'native seek preparation, arming, drip, no-hit recovery and generation adoption; manual fixture has known fixed endpoint; setup excluded; no hardware'}));
assert(elapsed[1][5]<=elapsed[0][5]*1.25,'Unified seek median time overhead exceeds 25%');assert(cpu[1][5]<=cpu[0][5]*1.5+1,'Unified seek CPU overhead exceeds 50% plus 1ms');assert(cpu[1][5]<20,'Unified seek CPU median exceeds 20ms desktop budget');
