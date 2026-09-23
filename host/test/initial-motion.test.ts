import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {initialMotionFixture as fixture,initialMotionOptions as options} from './helpers/initial-motion.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
import {BedMeshMovePort} from '../src/motion/bed-mesh-port.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
for(const reverse of [false,true])test(`configured startup reads counters and initializes real motion with auxiliary MCU ${reverse?'first':'last'}`,async()=>{
 const f=await fixture(reverse);try{
  f.firmware[0].setStepperPosition(0,123);const before=f.firmware[0].outputs.length;
  const initial=await initializeConfiguredMotion(f.hardware,options,f.signal),g=initial.generation,b=g.motion.bindings[0];
  assert.equal(initial.stopped.hitClock,null);assert.equal(initial.stopped.positions[0].raw,123);assert.equal(b.member,0);assert.equal(f.hardware.emitters![0].member,reverse?1:0);assert.equal(g.members[0].session,f.group.session('mcu'));assert.equal(g.auxiliaryMCUs[0].id,'aux');assert.equal(b.position.mcuPosition(0),123n);assert.equal(b.history.status.lastPlannedPosition,123n);assert.equal(f.firmware[0].motion.length,0);
  const writes=f.firmware[0].outputs.slice(before),query=writes.findIndex(o=>o.name==='stepper_get_position'),reset=writes.findIndex(o=>o.name==='reset_step_clock');assert(query>=0&&reset>query);assert(writes.some(o=>o.name==='stepper_stop_on_trigger'));assert(!writes.some(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0));
  const port=new BedMeshMovePort({mesh:null,physicalPosition:options.position,limits:motionLimits(100,1000),validate(){}});port.move([1,0,0,0],10);await g.source.drain(port.flush(),f.signal);
  assert.equal(b.history.status.lastPlannedPosition,203n);assert.equal(f.firmware[0].motion.filter(o=>o.name==='queue_step').reduce((n,o)=>n+Number(o.parameters.count),0),80);assert.equal(f.firmware[1].motion.length,0);
  await initial.close();assert.equal(f.hardware.status.state,'stopped');assert.throws(()=>b.stepper.calibration,/closed/);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();}
});
test('invalid routing and copied hardware owners cannot initiate physical motion ownership',async()=>{
 const f=await fixture();try{
  await assert.rejects(initializeConfiguredMotion(f.hardware,{...options,position:[0,0,0]},f.signal),/configuration/);
  await assert.rejects(initializeConfiguredMotion(f.hardware,{...options,position:[0,0,0,0,0],routes:[{id:'xyz'},{id:'e',extrusionAxis:3},{id:'e2',extrusionAxis:3}]},f.signal),/routing/);
  await assert.rejects(initializeConfiguredMotion(f.hardware,{...options,routes:[{id:'unknown'}]},f.signal),/routing/);assert.deepEqual(f.stops,[0,0]);
  await assert.rejects(initializeConfiguredMotion({...f.hardware},options,f.signal),/owner/);assert.deepEqual(f.stops,[0,0]);
  const initial=await initializeConfiguredMotion(f.hardware,options,f.signal);await assert.rejects(initializeConfiguredMotion(f.hardware,options,f.signal),/reused/);assert.equal(f.hardware.status.state,'ready');await initial.close();
 }finally{await f.close();}
});
for(const raw of [-0x80000000,0x7fffffff])test(`initial counter baseline preserves signed 32-bit endpoint ${raw}`,async()=>{
 const f=await fixture();try{
  f.firmware[0].setStepperPosition(0,raw);const initial=await initializeConfiguredMotion(f.hardware,options,f.signal);
  assert.equal(initial.generation.motion.bindings[0].position.mcuPosition(0),BigInt(raw));assert.equal(initial.generation.motion.bindings[0].history.status.lastPlannedPosition,BigInt(raw));assert.equal(f.firmware[0].motion.length,0);await initial.close();
 }finally{await f.close();}
});
test('counter query cancellation stops all hardware without publishing or sending motion',async()=>{
 const f=await fixture(),controller=new AbortController();try{
  f.firmware[0].ignore('stepper_get_position');const pending=initializeConfiguredMotion(f.hardware,options,controller.signal),rejected=assert.rejects(pending,/cancel initial motion/);
  await delay(20);controller.abort(new Error('cancel initial motion'));await rejected;assert.deepEqual(f.stops,[1,1]);assert.equal(f.hardware.status.state,'stopped');assert.equal(f.firmware[0].motion.length,0);assert.equal(f.hardware.analog[0].sensor.status.closed,true);
 }finally{await f.close();}
});
test('deadline cannot publish a partially initialized generation',async()=>{
 const f=await fixture();try{
  f.firmware[0].ignore('stepper_get_position');await assert.rejects(initializeConfiguredMotion(f.hardware,{...options,timeoutMs:50},f.signal),/timed out/);assert.deepEqual(f.stops,[1,1]);assert.equal(f.hardware.status.state,'stopped');assert.equal(f.firmware[0].motion.length,0);
 }finally{await f.close();}
});
test('hardware close waits for owned initial native resources to be disposed',async()=>{
 const f=await fixture();try{
  const initial=await initializeConfiguredMotion(f.hardware,{...options,fanSection:'fan'},f.signal),g=initial.generation;assert(g.boundaryOutput);await f.hardware.close();assert.throws(()=>g.motion.bindings[0].stepper.calibration,/closed/);assert.equal(f.hardware.fans[0].runtime.status.phase,'stopped');
 }finally{await f.close();}
});
