import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
async function until(check:()=>boolean,timeout=7000){const end=performance.now()+timeout;while(!check()){assert(performance.now()<end,'idle calibration did not reach expected state');await delay(5);}}
test('native owner skips busy dispatch then automatically calibrates idle clocks across periods',async()=>{
 const t=await nativeLinearFixture(0,()=>false,true,undefined,false,true,true),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{}),gate=Promise.withResolvers<void>();
 const clock=t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline;
 const ready=(segments:number)=>{if(t.port.status.failed)throw t.port.status.fault;return clock.status.segments>=segments&&!t.port.status.busy;};
 try{
  const busy=g.dispatch.runExclusive(()=>gate.promise,new AbortController().signal);await delay(600);assert.equal(clock.status.segments,1);gate.resolve();await busy;
  await until(()=>ready(2));assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);assert.equal(t.kinematics.status.homedAxes,'');
  await until(()=>ready(3));assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);
  t.kinematics.markHomed([0]);g.enable();await g.dispatch.execute('G1 X51 F600');assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.f.stops,0);
 }finally{gate.resolve();await g.close();await t.close();}
});
test('pending admitted movement prevents idle maintenance until the owning stream drains',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});try{
  t.kinematics.markHomed([0]);g.enable();t.port.move([51,0,0,2],10);assert.equal(t.port.idleClockMaintenanceDue,false);await delay(550);
  assert.equal(t.generation.clockTimelines![0].timeline.status.segments,1);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);
  await g.dispatch.execute('M400');assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.f.stops,0);
 }finally{await g.close();await t.close();}
});
test('closing during scheduled maintenance aborts and retires the owner without later callbacks',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});let calls=0;
 const original=t.port.maintainIdleClocks.bind(t.port);t.port.maintainIdleClocks=s=>{calls++;return original(s);};
 try{
  await until(()=>t.port.status.phase==='clock');await g.close();const count=calls;await delay(550);assert.equal(calls,count);assert.equal(t.port.status.busy,false);assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,2);
 }finally{await g.close();await t.close();}
});
test('scheduled calibration failure stops all peers and does not retry a failed owner',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,true,true),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});let calls=0;
 t.port.maintainIdleClocks=()=>{calls++;return Promise.reject(new Error('injected calibration failure'));};
 try{await until(()=>t.port.status.failed);await delay(550);assert.equal(calls,1);assert.equal(t.f.stops,2);assert.throws(()=>g.enable(),/closed/);}
 finally{await g.close();await t.close();}
});
