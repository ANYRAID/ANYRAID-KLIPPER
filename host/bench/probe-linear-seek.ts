import assert from 'node:assert/strict';
import {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {rebuiltFixture} from '../test/helpers/rebuilt-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const wall:number[][]=[[],[]],cpu:number[][]=[[],[]];
for(let run=0;run<14;run++)for(const mode of (run%2?['probe','home']:['home','probe']) as ('home'|'probe')[]){
 const f=await rebuiltFixture(false,true);let result:Awaited<ReturnType<LinearHomingSeek['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const generation=await bindRebuiltMotion(f.options),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100}),hit=generation.motion.bindings[0].stepper.clockAt(generation.motion.printTime+.052);
  timer=setTimeout(()=>{f.fw.setTriggerReason(1,8);f.fw.setStepperPosition(3,148);f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(hit+1000n)},7);f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(hit)});},Math.max(0,Number(hit-f.options.members[0].session.clock.sync.getClock(serialClock.now()))/1e6+.01)*1000);
  const start=performance.now(),used=process.cpuUsage();result=await new LinearHomingSeek({mode,generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groups:[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}]}).run([51,0,0,2],10,0,new AbortController().signal);
  const elapsed=performance.now()-start,usage=process.cpuUsage(used),index=mode==='probe'?1:0;if(run>=3){wall[index].push(elapsed);cpu[index].push((usage.user+usage.system)/1000);}
  assert.equal(result.triggerPosition[0],mode==='probe'?50.45:51);assert.equal(result.position[0],mode==='probe'?50.48:51.03);assert.equal(f.stops,0);
 }finally{clearTimeout(timer);result?.motion.dispose();await f.close();}
}
const stats=(a:number[])=>{a.sort((x,y)=>x-y);return {medianMs:a[5],p95Ms:a[10]};},home={wall:stats(wall[0]),cpu:stats(cpu[0])},probe={wall:stats(wall[1]),cpu:stats(cpu[1])};console.log(JSON.stringify({node:process.version,warmups:3,samples:11,home,probe,scope:'Native hit history and generation adoption, alternating home/probe with identical simulated trigger and counters. Setup excluded; no physical hardware.'}));assert(probe.wall.medianMs<=home.wall.medianMs*1.25+5);assert(probe.cpu.medianMs<=home.cpu.medianMs*1.5+1);assert(probe.cpu.medianMs<20);
