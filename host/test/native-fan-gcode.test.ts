import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const signal=()=>new AbortController().signal,rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
async function fixture(kickStartTime=0){const t=await nativeLinearFixture(0,()=>false,true,{kickStartTime,minimumScheduleTime:.001}),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});g.enable();return {t,g,writes:()=>t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation'),steps:()=>t.f.fw.motion.filter(m=>m.name==='queue_step'),close:async()=>{await g.close();await t.close();}};}
test('idle fan commands queue without motion permission and checkpoint confirms a stationary endpoint',async()=>{
 const f=await fixture();try{
  await f.t.port.queueCoolingFan(.5,signal());assert.equal(f.writes().length,0);assert.equal(f.t.generation.source.status.pendingBoundaries,1);
  await f.g.dispatch.execute('M106 S64',{boundary:'checkpoint'});assert.equal(f.steps().length,0);assert.deepEqual(f.writes().map(m=>m.parameters.value),[64]);assert.equal(f.t.kinematics.status.homedAxes,'');assert.equal(f.t.generation.source.status.paused,true);assert.equal(f.t.generation.source.status.pendingBoundaries,0);assert.equal(f.t.timeline!.status.pending,0);assert.deepEqual(f.t.port.position(),[50,0,0,2]);assert.equal(f.t.f.stops,0);
 }finally{await f.close();}
});
test('initial M106 binds to fresh motion start and M107 to the actual final endpoint',async()=>{
 const f=await fixture();try{
  f.t.kinematics.markHomed([0]);let start=0;const startAt=f.t.generation.source.startAt.bind(f.t.generation.source);f.t.generation.source.startAt=t=>{start=t;startAt(t);};
  const times=new Map<number,number>(),deliver=f.t.timeline!.deliver.bind(f.t.timeline);f.t.timeline!.deliver=async(b,h,s)=>{for(const v of b)times.set(v.id,v.time);return deliver(b,h,s);};
  await f.g.dispatch.execute('M106 S128\nG1 X51 F600\nM107');assert.deepEqual(f.writes().map(m=>m.parameters.value),[128,0]);assert.equal(times.get(1),start);assert(times.get(2)!>start);
  assert.deepEqual(f.writes().map(m=>Number(m.parameters.clock)),[1,2].map(id=>Number(BigInt.asUintN(32,f.t.generation.motion.bindings[0].stepper.clockAt(times.get(id)!)))));assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.t.f.stops,0);
 }finally{await f.close();}
});
test('fan changes between admitted moves preserve junction velocity and do not insert a drain',async()=>{
 const f=await fixture();try{
  f.t.kinematics.markHomed([0]);const source=f.t.generation.source,append=source.append.bind(source),drain=source.drain.bind(source);let drains=0,join=0;
  source.append=moves=>{join=moves[0]?.profile?.endV??0;append(moves);};source.drain=async(...args)=>{drains++;await drain(...args);};
  await f.g.dispatch.execute('G1 X50.5 F600\nM106 S128\nG1 X51 F600\nM107');assert.equal(drains,1);assert(join>0);assert.deepEqual(f.writes().map(m=>m.parameters.value),[128,0]);assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.t.f.stops,0);
 }finally{await f.close();}
});
test('fan command after a drained move uses fresh idle time and repeated M400 does not replay it',async()=>{
 const f=await fixture();try{
  f.t.kinematics.markHomed([0]);await f.g.dispatch.execute('G1 X51 F600');const old=f.t.generation.source.status.sourceTime,count=f.steps().length;await f.g.dispatch.execute('M106 S128\nM400\nM400');assert.equal(f.writes().length,1);assert(Number(f.writes()[0].parameters.clock)>Number(BigInt.asUintN(32,f.t.generation.motion.bindings[0].stepper.clockAt(old))));assert.equal(f.steps().length,count);assert.equal(f.t.f.stops,0);
 }finally{await f.close();}
});
test('cancelled idle fan checkpoint cannot publish completion or move motors',async()=>{
 const f=await fixture(.4),cancel=new AbortController();try{
  await f.t.port.queueCoolingFan(.5,signal());const running=f.t.port.flush(cancel.signal),rejected=assert.rejects(running,/cancel idle fan/),deadline=performance.now()+3000;
  while(!f.writes().length){assert(performance.now()<deadline);await delay(2);}cancel.abort(new Error('cancel idle fan'));await rejected;assert.equal(f.steps().length,0);assert.equal(f.t.port.status.failed,true);assert.equal(f.t.timeline!.status.stopped,true);assert.equal(f.t.f.stops,1);
 }finally{await f.close();}
});
test('G28 cannot silently lose the configured fan across an unsupported generation transfer',async()=>{
 const f=await fixture();try{await assert.rejects(f.g.dispatch.execute('G28 X'),/Native motion stopped/);assert.match(String(f.t.port.status.fault),/Boundary output transfer/);assert.equal(f.steps().length,0);assert.equal(f.t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0).length,0);assert.equal(f.t.port.status.failed,true);}finally{await f.close();}
});
test('unconfigured M106 remains unsupported and rejects the motion suffix',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});try{t.kinematics.markHomed([0]);g.enable();await assert.rejects(g.dispatch.execute('M106 S128\nG1 X51 F600'),/Unsupported command/);assert.equal(t.port.status.failed,true);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step').length,0);}finally{await g.close();await t.close();}
});
