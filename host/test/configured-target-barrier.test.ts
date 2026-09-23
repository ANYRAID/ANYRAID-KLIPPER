import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {initialMotionFixture} from './helpers/initial-motion.ts';
import {initialLinearFixture} from './helpers/initial-linear.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
async function sample(f:Awaited<ReturnType<typeof initialLinearFixture>>){
 const plan=f.hardware.plan.heaters[0],session=f.group.session(plan.sensor.mcu),raw=Math.round(plan.configuration.converter.adc(25)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;
 f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});
 const deadline=performance.now()+1000;while(!f.hardware.analog[0].runtime.status.received){assert(performance.now()<deadline);await delay(2);}
}
test('managed heater targets require motion initialization and the linear handoff',async()=>{
 const raw=await initialMotionFixture(false,true);try{await assert.rejects(raw.hardware.heaters.setTarget('extruder',200,raw.signal),/barrier is not ready/);assert.equal(raw.hardware.analog[0].runtime.status.target,0);assert.deepEqual(raw.stops,[0,0]);}finally{await raw.hardware.close();await raw.close();}
 const f=await initialLinearFixture();try{
  await assert.rejects(f.hardware.heaters.setTarget('extruder',200,f.signal),/barrier is not ready/);assert.equal(f.hardware.analog[0].runtime.status.target,0);assert.deepEqual(f.stops,[0,0]);
  f.initial.createLinearPort(f.reader,f.settings);await sample(f);await f.hardware.heaters.setTarget('extruder',200,f.signal);assert.equal(f.hardware.analog[0].runtime.status.target,200);
 }finally{await f.hardware.close();await f.close();}
});
test('managed target waits for admitted native motion and every MCU clock',async()=>{
 const f=await initialLinearFixture();try{
  const {port,kinematics}=f.initial.createLinearPort(f.reader,f.settings);await sample(f);kinematics.markHomed([0]);port.move([1,0,0,0],10);
  const setting=f.hardware.heaters.setTargets([{name:'extruder',target:200}],f.signal);await delay(10);assert.equal(f.hardware.analog[0].runtime.status.target,0);await setting;
  assert.equal(f.hardware.analog[0].runtime.status.target,200);assert.equal(port.status.pendingMoves,0);
  assert.equal(f.initial.generation.motion.bindings[0].history.status.lastPlannedPosition,80n);
  const end=f.initial.generation.source.status.sourceTime;for(const member of f.initial.generation.clockMembers)assert(member.session.clock.sync.getClock(serialClock.now())>=member.stepper.clockAt(end));
 }finally{await f.hardware.close();await f.close();}
});
test('cancelling a target during motion drain stops hardware without applying heat',async()=>{
 const f=await initialLinearFixture(),controller=new AbortController();try{
  const {port,kinematics}=f.initial.createLinearPort(f.reader,f.settings);await sample(f);kinematics.markHomed([0]);port.move([1,0,0,0],1);
  const pending=f.hardware.heaters.setTarget('extruder',200,controller.signal),rejected=assert.rejects(pending);await delay(10);controller.abort(new Error('cancel heater boundary'));await rejected;await f.hardware.close();
  assert.equal(f.hardware.analog[0].runtime.status.target,0);assert.equal(port.status.failed,true);assert.deepEqual(f.stops,[1,1]);assert(!f.firmware[1].outputs.some(o=>o.name==='queue_digital_out_generation'&&Number(o.parameters.on_ticks)>0));
 }finally{await f.hardware.close();await f.close();}
});
test('confirmed pause permits heater targets without resuming or adding motion',async()=>{
 const f=await initialLinearFixture();try{
  const {port,kinematics}=f.initial.createLinearPort(f.reader,f.settings);kinematics.markHomed([0]);port.move([1,0,0,0],10);await port.pause(f.signal);await sample(f);
  const before=f.firmware[0].motion.length,steps=f.initial.generation.motion.bindings[0].history.status.lastPlannedPosition,mode=port.status.pauseMode;
  await f.hardware.heaters.setTarget('extruder',200,f.signal);assert.equal(f.hardware.analog[0].runtime.status.target,200);assert.equal(port.status.pauseMode,mode);assert.equal(f.initial.generation.source.status.paused,true);assert.equal(f.firmware[0].motion.length,before);assert.equal(f.initial.generation.motion.bindings[0].history.status.lastPlannedPosition,steps);
  await port.resumeStream(f.signal);assert.equal(port.status.failed,false);
 }finally{await f.hardware.close();await f.close();}
});
test('parking travel during pause cannot authorize a heater target boundary',async()=>{
 const f=await initialLinearFixture();try{
  const {port,kinematics}=f.initial.createLinearPort(f.reader,f.settings);kinematics.markHomed([0]);await port.pause(f.signal);await sample(f);
  const moving=port.movePaused([1,0,0,0],10,f.signal);await assert.rejects(f.hardware.heaters.setTarget('extruder',200,f.signal),/not stationary/);assert.equal(f.hardware.analog[0].runtime.status.target,0);
  await moving;await f.hardware.heaters.setTarget('extruder',200,f.signal);assert.equal(f.hardware.analog[0].runtime.status.target,200);assert.equal(port.status.failed,false);assert.equal(f.initial.generation.source.status.paused,true);
 }finally{await f.hardware.close();await f.close();}
});
