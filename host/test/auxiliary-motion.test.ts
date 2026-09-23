import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const signal=()=>new AbortController().signal;
test('shared generation clocks require complete distinct MCU ownership',async()=>{
 for(const mode of ['missing','shared','mismatch']){
  const f=await rebuiltFixture(false,false,false,false,true);try{
   const main=new PrintClockTimeline({offset:0,frequency:mode==='mismatch'?999999:1e6}),aux=new PrintClockTimeline({offset:0,frequency:1e6}),clockTimelines=mode==='missing'?[{id:'m',timeline:main}]:[{id:'m',timeline:main},{id:'a',timeline:mode==='shared'?main:aux}];
   await assert.rejects(bindRebuiltMotion({...f.options,clockTimelines}),/Shared clocks|shared MCU calibration/);assert.equal(f.stops,2);
  }finally{await f.close();}
 }
});
test('motion drain covers auxiliary MCU time without allocating fake emitters or queues',async()=>{
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const g=await bindRebuiltMotion(f.options),port=new BedMeshMovePort({mesh:null,physicalPosition:f.options.position,limits:motionLimits(100,1000),validate(){}});
  assert.equal(g.members.length,1);assert.equal(g.clockMembers.length,2);assert.deepEqual(g.sink.clockSources().map(c=>c.id),['m']);
  port.move([51,0,0,2.1],10);await g.source.drain(port.flush(),signal());
  const targets=g.sink.motionClockTargets(Object.fromEntries(g.motion.bindings.map(b=>[b.id,b.history.status.throughClock])));assert.deepEqual(Object.keys(targets),['m']);
  assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(g.motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(f.auxFw!.motion.length,0);
  const clock=g.clockMembers.find(c=>c.mcu==='a')!;assert(clock.session.clock.sync.lastClock>clock.stepper.clockAt(g.coordinator.status.committedTime));assert.equal(f.stops,0);
 }finally{await f.close();}
});
for(const failure of ['missing','overlap','unknown','invalid-clock'] as const)test(`auxiliary mapping rejects ${failure} and stops all physical MCUs`,async()=>{
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const auxiliaryMCUs=failure==='missing'?[]:[{id:failure==='overlap'?'m':failure==='unknown'?'other':'a',calibration:{offset:0,frequency:failure==='invalid-clock'?NaN:1e6}}];
  await assert.rejects(bindRebuiltMotion({...f.options,auxiliaryMCUs}));assert.equal(f.stops,2);
 }finally{await f.close();}
});
test('auxiliary fan survives coordinate rebuild with one generation and correct MCU routing',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,{kickStartTime:0,minimumScheduleTime:.001},false,true);try{
  await t.port.queueCoolingFan(.5,signal());await t.port.drain(signal());
  await t.port.forcePosition([50.1,0,0,2],signal());await t.port.queueCoolingFan(.25,signal());await t.port.drain(signal());
  const writes=t.f.auxFw!.outputs.filter(o=>o.name==='queue_pwm_out_generation');assert.deepEqual(writes.map(o=>o.parameters.value),[128,64]);assert.equal(new Set(writes.map(o=>o.parameters.generation)).size,1);
  assert.equal(t.f.fw.outputs.filter(o=>o.name==='queue_pwm_out_generation').length,0);assert.equal(t.f.auxFw!.motion.length,0);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('auxiliary MCU failure invalidates motion and fan owners',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,{kickStartTime:0,minimumScheduleTime:.001},false,true);try{
  await t.f.options.group.session('a').stop(new Error('auxiliary fault'));await t.f.options.group.stop();
  assert.equal(t.f.stops,2);assert.equal(t.port.status.failed,true);assert.equal(t.timeline!.status.stopped,true);await assert.rejects(t.port.queueCoolingFan(.5,signal()));
 }finally{await t.close();}
});
test('auxiliary clock snapshot cannot be changed through caller configuration',async()=>{
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const g=await bindRebuiltMotion(f.options);f.options.auxiliaryMCUs[0].calibration.frequency=1;
  assert.equal(g.auxiliaryMCUs[0].calibration.frequency,1e6);assert.equal(g.clockMembers.find(c=>c.mcu==='a')!.stepper.clockAt(2),2000000n);assert(Object.isFrozen(g.auxiliaryMCUs[0].calibration));
 }finally{await f.close();}
});
test('missing auxiliary clock response prevents successful drain and stops both controllers',async()=>{
 const f=await rebuiltFixture(false,false,false,false,true);try{
  const g=await bindRebuiltMotion(f.options),port=new BedMeshMovePort({mesh:null,physicalPosition:f.options.position,limits:motionLimits(100,1000),validate(){}});f.auxFw!.ignore('get_clock');port.move([51,0,0,2.1],10);
  await assert.rejects(g.source.drain(port.flush(),signal(),700),/timed out|timeout|deadline|Unable to obtain 'clock' response/i);assert.equal(f.stops,2);assert.equal(f.options.group.status.state,'stopped');
 }finally{await f.close();}
});
test('G28 preserves auxiliary fan ownership through homing recovery and subsequent motion',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,{kickStartTime:0,minimumScheduleTime:.001},false,true);let sent=false;
 const timer=setInterval(()=>{
  const arm=t.f.fw.outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0);if(!arm||sent)return;const clock=Number(arm.parameters.clock);if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<BigInt(clock))return;
  sent=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});
 },1);
 try{
  await t.port.queueCoolingFan(.5,signal());await t.port.drain(signal());await t.command.home([0],signal());assert(sent);assert.equal(t.kinematics.status.homedAxes,'x');
  t.port.move([51.5,0,0,2],10);await t.port.queueCoolingFan(0,signal());await t.port.drain(signal());assert.deepEqual(t.f.auxFw!.outputs.filter(o=>o.name==='queue_pwm_out_generation').map(o=>o.parameters.value),[128,0]);assert.equal(t.f.auxFw!.motion.length,0);assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await t.close();}
});
