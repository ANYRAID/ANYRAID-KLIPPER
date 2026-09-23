import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {bindRebuiltMotion,type BoundaryOutputTransfer} from '../src/runtime/rebuilt-motion.ts';
import {CoordinateRebase} from '../src/homing/recovery.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal,fixture=()=>nativeLinearFixture(0,()=>false,false,{kickStartTime:0,minimumScheduleTime:.001});
async function recover(t:Awaited<ReturnType<typeof fixture>>){const g=t.generation;return (await new CoordinateRebase({coordinator:g.coordinator,bindings:g.motion.bindings,members:g.members,emitters:t.f.emitters,locate:()=>({queues:[{id:'xyz',position:[50,0,0]},{id:'e',position:[2,0,0]}],printTime:Number(g.members[0].session.clock.sync.getClock(serialClock.now()))/1e6+.2})}).recover(signal())).motion;}
function options(t:Awaited<ReturnType<typeof fixture>>,motion:Awaited<ReturnType<typeof recover>>,boundaryTransfer:BoundaryOutputTransfer){return {...t.f.options,motion,boundaryTransfer,routes:[{queue:motion.bindings[0].queue},{queue:motion.bindings[1].queue,extrusionAxis:3}]};}
test('pending output prevents transfer without losing its owner',async()=>{
 const t=await fixture();try{await t.port.queueCoolingFan(.5,signal());assert.throws(()=>t.generation.releaseBoundaryOutput(),/settled requests/);assert.equal(t.generation.boundaryOutput!.status.pending,1);await t.port.drain(signal());await t.port.forcePosition([50,0,0,2],signal());assert.throws(()=>t.generation.boundaryOutput!.register(.2),/ownership transferred/);await t.port.queueCoolingFan(0,signal());await t.port.drain(signal());assert.deepEqual(t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation').map(m=>m.parameters.value),[128,0]);assert.equal(t.f.stops,0);}finally{await t.close();}
});
test('released output requires old coordinator retirement before adoption',async()=>{
 const t=await fixture();try{const token=t.generation.releaseBoundaryOutput()!;assert.throws(()=>t.generation.releaseBoundaryOutput(),/ownership transferred/);await assert.rejects(bindRebuiltMotion({...t.f.options,boundaryTransfer:token}),/requires retired motion/);assert.equal(t.timeline!.status.stopped,true);assert.equal(t.f.stops,1);}finally{await t.close();}
});
for(const invalid of ['forged','mapping','reused'] as const)test(`output transfer rejects ${invalid} ownership and stops the group`,async()=>{
 const t=await fixture();let motion:Awaited<ReturnType<typeof recover>>|undefined;try{
  const token=t.generation.releaseBoundaryOutput()!;motion=await recover(t);const o=options(t,motion,token);
  if(invalid==='mapping')for(const b of motion.bindings)b.stepper.calibrateClock(0,1000001);
  if(invalid==='reused')await bindRebuiltMotion(o);
  await assert.rejects(bindRebuiltMotion(invalid==='forged'?{...o,boundaryTransfer:{kind:'boundary-output-transfer'}}:o),invalid==='mapping'?/clock mapping differs/:/Invalid or consumed/);assert.equal(t.timeline!.status.stopped,true);assert.equal(t.f.stops,1);
 }finally{motion?.dispose();await t.close();}
});
for(const origin of ['group','fan'] as const)test(`a ${origin} failure still reaches both sides while output is released`,async()=>{
 const t=await fixture();try{t.generation.releaseBoundaryOutput();await (origin==='group'?t.generation.group:t.timeline!).stop(new Error('handoff failure'));assert.equal(t.timeline!.status.stopped,true);assert.equal(t.generation.group.status.state,'stopped');assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('repeated coordinate rebuilds retain a single output subscription and PWM generation',async()=>{
 const t=await fixture();let subscriptions=0;const subscribe=t.timeline!.subscribeStop.bind(t.timeline!);t.timeline!.subscribeStop=listener=>{subscriptions++;return subscribe(listener);};try{
  await t.port.queueCoolingFan(.5,signal());await t.port.drain(signal());const resets=t.f.fw.outputs.filter(m=>m.name==='reset_pwm_out_generation').length;assert.equal(resets,1);
  for(let i=0;i<5;i++)await t.port.forcePosition([50+i/10,0,0,2],signal());
  await t.port.queueCoolingFan(.25,signal());await t.port.drain(signal());const writes=t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation');assert.deepEqual(writes.map(m=>m.parameters.value),[128,64]);assert.equal(new Set(writes.map(m=>m.parameters.generation)).size,1);assert.equal(t.f.fw.outputs.filter(m=>m.name==='reset_pwm_out_generation').length,resets);assert.equal(subscriptions,0);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('output cannot be adopted by a different MCU group',async()=>{
 const t=await fixture();const other=await nativeLinearFixture();try{const token=t.generation.releaseBoundaryOutput()!;await assert.rejects(bindRebuiltMotion({...other.f.options,boundaryTransfer:token}),/same MCU group/);assert.equal(t.timeline!.status.stopped,true);assert.equal(t.f.stops,1);assert.equal(other.f.stops,1);}finally{await other.close();await t.close();}
});
