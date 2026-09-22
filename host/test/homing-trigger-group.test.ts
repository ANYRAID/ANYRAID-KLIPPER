import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingRecovery} from '../src/homing/recovery.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
const signal=()=>new AbortController().signal;
function setup(f:Awaited<ReturnType<typeof recoveryFixture>>,lead=.3){const starts=f.sessions.map(s=>s.clock.sync.getClock(serialClock.now()+lead)),sampling=f.options.endstop.home({printTime:Number(starts[0])/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.round(t*1e6)));return {starts,sampling,group:new HomingTriggerGroup(f.options.members,0,f.options.endstop,sampling,starts,.25)};}
test('all stepper registrations precede sampling and native hit completion integrates with recovery',async()=>{
 const f=await recoveryFixture(),{starts,sampling,group}=setup(f);let recovered:Awaited<ReturnType<HomingRecovery['recover']>>|undefined;
 try{
  const armed=group.arm(signal());assert.strictEqual(group.arm(signal()),armed);await armed;assert.equal(group.status.armed,true);
  for(const fw of f.fs){const names=fw.outputs.map(o=>o.name);assert(names.indexOf('stepper_stop_on_trigger')>names.indexOf('trsync_start'));assert(names.indexOf('trsync_set_timeout')>names.indexOf('stepper_stop_on_trigger'));}
  const names=f.fs[0].outputs.map(o=>o.name);assert(names.indexOf('endstop_home')>names.indexOf('trsync_set_timeout'));
  await delay(320);f.fs[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(starts[0]+sampling.restTicks)});f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(starts[0])});
  assert([1,2].includes((await group.completion).reason));f.options.sampling=sampling;f.options.release=()=>group.release();recovered=await new HomingRecovery(f.options).recover(signal());assert.equal(recovered.stop.reasons[0],1);assert.equal(recovered.stop.hitClock,starts[0]);assert(group.status.released);assert.equal(f.stops,0);
 }finally{group.release();recovered?.motion.dispose();await f.close();}
});
test('invalid packets and expired clocks fail before firmware writes',async()=>{
 const f=await recoveryFixture(1);try{
  const starts=[f.sessions[0].clock.sync.getClock(serialClock.now()+1)],sampling={...f.options.sampling,reqClock:starts[0],payload:f.options.endstop.stop()},before=f.fs[0].outputs.length;
  assert.throws(()=>new HomingTriggerGroup(f.options.members,0,f.options.endstop,sampling,starts,.25),/sampling/);
  for(const override of [{pin_value:2},{sample_ticks:0x80000000},{sample_ticks:0x7fffffff,sample_count:3}]){
   const payload=f.sessions[0].dictionary.encode('endstop_home',{oid:7,clock:Number(starts[0]),sample_ticks:15,sample_count:4,rest_ticks:1000,pin_value:0,trsync_oid:8,trigger_reason:1,...override});
   assert.throws(()=>new HomingTriggerGroup(f.options.members,0,f.options.endstop,{payload,reqClock:starts[0],restTicks:1000n},starts,.25),/sampling/);
  }
  assert.throws(()=>setup(f,-1),/expired/);assert.equal(f.fs[0].outputs.length,before);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('partial MCU arming failure releases native group and stops all members',async()=>{
 const f=await recoveryFixture(),{group}=setup(f);try{
  const decoder=new FrameDecoder();f.fs[0].peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of f.fs[0].dictionary.parseFrame(frame))if(command.name==='trsync_start')void f.sessions[1].stop(new Error('arm link failure'));});
  await assert.rejects(group.arm(signal()));await assert.rejects(group.completion);assert(group.status.released);assert.equal(f.stops,2);assert(!f.fs[0].outputs.some(o=>o.name==='endstop_home'));
 }finally{group.release();await f.close();}
});
test('pre-cancelled arming stops the group and a released group cannot rearm',async()=>{
 const f=await recoveryFixture(1),{group}=setup(f);try{const abort=new AbortController();abort.abort(new Error('cancel arm'));await assert.rejects(group.arm(abort.signal),/cancel arm/);assert.equal(f.stops,1);assert(group.status.released);await assert.rejects(group.arm(signal()));}finally{group.release();await f.close();}
});
test('firmware trigger failure after arming closes all MCU sessions',async()=>{
 const f=await recoveryFixture(),{group}=setup(f);try{await group.arm(signal());f.fs[0].emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:4,clock:0});await assert.rejects(group.completion,/trigger stopped/);await Promise.all(f.sessions.map(s=>s.stop()));assert.equal(f.stops,2);assert(group.status.released);}finally{group.release();await f.close();}
});
