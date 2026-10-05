import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {idleMotionFixture} from './helpers/idle-motion.ts';
const signal=()=>new AbortController().signal;
for(const filtered of [false,true])test(`idle calibration preserves stationary counters and subsequent movement (filtered=${filtered})`,async()=>{
 const t=await nativeLinearFixture(0,()=>true,filtered,undefined,false,true,true);try{
  const clock=t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline;
  const running=t.port.maintainIdleClocks(signal());assert.equal(t.port.status.phase,'clock');
  assert.throws(()=>t.port.move([51,0,0,2],10),/busy/);
  assert.deepEqual(await running,{attempted:1,updated:1});assert.equal(clock.status.segments,2);
  assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.equal(t.generation.source.status.paused,true);
  assert.deepEqual(t.port.position(),[50,0,0,2]);assert.equal(t.kinematics.status.homedAxes,'');
  assert.deepEqual(await t.port.maintainIdleClocks(signal()),{attempted:0,updated:0});
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],10);
  assert.throws(()=>t.port.maintainIdleClocks(signal()),/stationary ownership/);assert.equal(t.port.status.failed,false);
  await t.port.drain(signal());assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.generation.motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(t.f.stops,0);
  await t.port.forcePosition([51,0,0,2.1],signal());
  // Rebuilding/draining may consume the next one-second interval. Permit its
  // required successful refresh and verify stationary ownership, not elapsed
  // wall time. A failed refresh still fails this assertion.
  const pulses=t.f.fw.motion.filter(m=>m.name==='queue_step').length,refresh=await t.port.maintainIdleClocks(signal());
  assert(refresh.attempted===0||refresh.attempted===1);assert.equal(refresh.updated,refresh.attempted);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,pulses);assert.deepEqual(t.port.position(),[51,0,0,2.1]);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('idle calibration cancellation stops the owner and every MCU',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true),cancel=new AbortController();try{
  const running=t.port.maintainIdleClocks(cancel.signal),rejected=assert.rejects(running);cancel.abort(new Error('cancel idle calibration'));await rejected;
  assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,2);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
test('homing after idle calibration adopts the live clock and preserves authority checks',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true);let hit=false;
 const timer=setInterval(()=>{
  const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||hit)return;
  const clock=Number(arm.parameters.clock);if(BigInt(t.f.fw.currentClock())<BigInt(clock))return;
  hit=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});
 },1);
 try{
  assert.deepEqual(await t.port.maintainIdleClocks(signal()),{attempted:1,updated:1});assert.equal(t.kinematics.status.homedAxes,'');
  await t.command.home([0],signal());assert(hit);assert.equal(t.kinematics.status.homedAxes,'x');assert.deepEqual(t.port.position(),[51,0,0,2]);assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await t.close();}
});
test('invalid idle calibration reservation cannot seed or mutate source',async()=>{
 const f=idleMotionFixture();try{
  f.source.startAt(1);const before=f.source.status;
  for(const reserve of [-1,NaN,Infinity,.011])await assert.rejects(f.source.prepareIdle(signal(),30000,reserve),/reserve/);
  assert.deepEqual(f.source.status,before);assert.equal(f.commits,0);assert.equal(f.stops,0);
  await f.source.prepareIdle(signal(),30000,.01);assert.equal(f.coordinator.status.generatedTime,1-.01-.001);assert.equal(f.source.status.sourceTime,1);
 }finally{f.close();}
});
