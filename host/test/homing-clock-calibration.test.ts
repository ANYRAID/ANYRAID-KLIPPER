import test from 'node:test';
import assert from 'node:assert/strict';
import {HomingMoveExecution} from '../src/homing/move-execution.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {nativeHomingFixture} from './helpers/homing-move-execution.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LinearHomingSeek} from '../src/homing/linear-seek.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {prepareHomingTrajectory} from '../src/homing/prepare-trajectory.ts';
const signal=()=>new AbortController().signal;
const kin=()=>new LinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
test('delayed coupled hit uses historical maps across calibration and pins them through retirement',async()=>{
 const x=await nativeHomingFixture(2),timelines=x.f.options.bindings.map(b=>new PrintClockTimeline(b.stepper.calibration)),clocks=new Map(x.f.options.bindings.map((b,i)=>[b.id,timelines[i]]));
 const hit=timelines[0].clockAt(x.options.startTime+.02),expected=timelines.map(t=>t.clockAt(timelines[0].printTimeAtClock(hit)));
 let calls=0,updated=false,timer:ReturnType<typeof setTimeout>|undefined,result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;
 try{
  using move=new HomingMoveExecution({...x.options,clockTimelines:clocks,prepareWindow:until=>{
   if(++calls!==2)return;
   for(const [i,t] of timelines.entries()){
    const c=x.f.options.coordinator,plan=t.planCalibration(c.status.generatedTime,Math.min(until,c.status.generatedTime+.009),1005000+i*1000);assert(plan);
    c.generateCalibrationBoundary(plan.time);t.calibrateMotion(plan.tick,1005000+i*1000,c,[`s${i}`]);
   }
   updated=true;
  },locate:readback=>{
   assert(updated);assert.deepEqual(readback.triggerClocks[0],expected);
   for(const t of timelines){t.retireBefore(t.status.latestClock);assert.equal(t.status.fromClock,0n);}
   assert.notEqual(x.f.options.bindings[0].stepper.printTimeAtClock(hit),timelines[0].printTimeAtClock(hit));
   return x.options.locate(readback);
  }});
  timer=setTimeout(()=>{
   x.f.fs[0].setTriggerReason(1,8);x.f.fs[0].setStepperPosition(1,23);
   x.f.fs[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(hit+x.options.groups[0].sampling.restTicks)},7);
   x.f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(hit)});
  },(x.lead+.025)*1000);
  result=await move.run(signal());assert.deepEqual(result.offsets.map(p=>p.trigger),[20n,20n]);assert.equal(x.f.stops,0);
  for(const [i,t] of timelines.entries()){assert.deepEqual(result.motion.bindings[i].stepper.calibration,t.status.calibration);t.retireBefore(t.status.latestClock);assert(t.status.fromClock>expected[i]);}
 }finally{clearTimeout(timer);result?.motion.dispose();await x.close();}
});
test('shared homing rejects missing or foreign timeline coverage before arming',async()=>{
 const x=await nativeHomingFixture(2);try{
  const t=new PrintClockTimeline(x.f.options.bindings[0].stepper.calibration);
  assert.throws(()=>new HomingMoveExecution({...x.options,clockTimelines:new Map([['s0',t]])}),/coverage/);
  assert.throws(()=>new HomingMoveExecution({...x.options,clockTimelines:new Map([['s0',t],['s1',t]])}),/mapping differs/);
  assert(!x.f.fs.some(f=>f.outputs.some(o=>o.name==='trsync_start')));assert.equal(x.f.stops,0);
 }finally{await x.close();}
});
for(const filtered of [false,true])test(`linear seek periodically calibrates and rebinds all motion emitters (filtered=${filtered})`,async()=>{
 const f=await rebuiltFixture(false,true,false,false,true),clock=new PrintClockTimeline({offset:0,frequency:1e6});let result:Awaited<ReturnType<LinearHomingSeek['run']>>|undefined;
 try{
  const group=f.options.group,sync=new SecondarySync(group.session('a').clock.sync,group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
  const generation=await bindRebuiltMotion({...f.options,clockTimelines:[{id:'m',timeline:clock,synchronizer:sync},{id:'a',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]});
  if(filtered)generation.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});
  f.fw.setTriggerReason(3,8);f.fw.setStepperPosition(3,200);
  const options={generation,kinematics:kin(),emitters:f.emitters,kinematicIds:['x','y','z'] as const,groups:[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}]};
  result=await new LinearHomingSeek(options).run([51,0,0,2],.2,0,signal(),15000);
  assert(clock.status.segments>=3);assert.deepEqual(result.missingHits,[0]);assert.equal(result.offsets[0].trigger,200n);assert.deepEqual(result.position,[51,0,0,2]);assert.equal(f.stops,0);
  for(const b of result.motion.bindings)assert.deepEqual(b.stepper.calibration,clock.status.calibration);
  assert.equal(result.generation.clockTimelines![0].synchronizer,sync);
  assert.throws(()=>generation.maintainClocks(100),/ownership/);
 }finally{result?.motion.dispose();await f.close();}
});
test('prepared calibration owner is bounded, one-use, and rejects retired or competing generation',async()=>{
 const f=await rebuiltFixture();try{
  const g=await bindRebuiltMotion(f.options);assert.throws(()=>g.handoffHomingClocks(10,11),/handoff/);
  const p=await prepareHomingTrajectory(g,kin(),[51,0,0,2],10,0,signal());
  assert.throws(()=>g.handoffHomingClocks(p.endTime,p.sourceUntil),/handoff/);
  assert.throws(()=>p.prepareWindow(p.endTime+.01),/exceeds/);
  assert.deepEqual(p.prepareWindow(p.startTime),{attempted:0,updated:0});
  await g.coordinator.shutdown();assert.throws(()=>p.prepareWindow(p.endTime),/ownership|MCU/);
 }finally{await f.close();}
});
test('calibration failure after generating a prefix stops homing without reset and releases clock history',async()=>{
 const x=await nativeHomingFixture(),binding=x.f.options.bindings[0],timeline=new PrintClockTimeline(binding.stepper.calibration);try{
  using move=new HomingMoveExecution({...x.options,clockTimelines:new Map([[binding.id,timeline]]),prepareWindow:until=>{
   const c=x.f.options.coordinator,plan=timeline.planCalibration(c.status.generatedTime,Math.min(until,c.status.generatedTime+.009),1001000);assert(plan);
   c.generateCalibrationBoundary(plan.time);timeline.calibrateMotion(plan.tick,1001000,c,[binding.id]);throw new Error('injected homing calibration failure');
  }});
  await assert.rejects(move.run(signal()),/injected homing calibration failure/);assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));
  timeline.retireBefore(timeline.status.latestClock);assert(timeline.status.fromClock>0n);
 }finally{await x.close();}
});
