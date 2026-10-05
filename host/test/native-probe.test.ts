import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
test('owned Z probe drains queued motion, measures physical coordinates and retains mesh through recovery',async()=>{
 const t=await nativeLinearFixture(),s=new AbortController().signal;let sent=false;
 const timer=setInterval(()=>{const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||sent)return;const hit=Number(arm.parameters.clock)+50000;if(BigInt(t.f.fw.currentClock())<BigInt(hit+1000))return;sent=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setStepperPosition(2,-15);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});},1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  const mesh=new BedMesh({min_x:0,max_x:100,min_y:0,max_y:100,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct',tension:.2},[[.2,.2],[.2,.2]]);await t.port.replaceBedMesh(mesh,{},s,'saved');t.coordinates.resetPosition();t.coordinates.execute('G1',{X:51,F:600});assert(t.port.status.pendingMoves>0);
  const result=await t.port.probeZ(0,5,t.groups,s);assert(sent);assert.deepEqual(result.trigger,[51,0,.88,2]);assert.deepEqual(result.halt,[51,0,.85,2]);assert.deepEqual(t.port.homingPosition(),result.halt);assert.equal(t.port.position()[2],.85-.2);assert.equal(t.port.bedMeshStatus.profile_name,'saved');assert.equal(t.kinematics.status.homedAxes,'xyz');assert.equal(t.f.stops,0);
  t.coordinates.resetPosition();t.coordinates.execute('G1',{Z:1,F:300});await t.port.drain(s);assert.equal(t.port.homingPosition()[2],1.2);
 }finally{clearInterval(timer);await t.close();}
});
for(const failure of ['unhomed','upward','range','cancelled'] as const)test(`invalid owned probe fences motion before arming (${failure})`,async()=>{
 const t=await nativeLinearFixture(),s=new AbortController().signal;
 try{
  await t.port.forcePosition([50,0,1,2],s);if(failure!=='unhomed')t.kinematics.markHomed([0,1,2]);const before=t.f.fw.outputs.length;
  await assert.rejects(t.port.probeZ(failure==='upward'?2:failure==='range'?-1:0,5,t.groups,failure==='cancelled'?AbortSignal.abort(new Error('cancel probe')):s));
  assert(!t.f.fw.outputs.slice(before).some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0));assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
for(const failure of ['no-hit','during-rebase'] as const)test(`owned probe failure invalidates homing and refuses further motion (${failure})`,async()=>{
 const t=await nativeLinearFixture(),s=new AbortController().signal;let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);const cancel=new AbortController();
  const running=t.port.probeZ(0,5,t.groups,cancel.signal);if(failure==='during-rebase')timer=setTimeout(()=>cancel.abort(new Error('cancel owned probe')),1);else timer=setInterval(()=>{if(t.f.fw.outputs.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))t.f.fw.setTriggerReason(3,8);},1);
  await assert.rejects(running,failure==='no-hit'?/Probe did not trigger/:/cancel owned probe/);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.throws(()=>t.port.move([50,0,1,2],5),/stopped/);
 }finally{clearTimeout(timer);await t.close();}
});
for(const initial of ['triggered','sampling'] as const)test(`owned probe rejects ${initial} input before downward motion`,async()=>{
 const t=await nativeLinearFixture(),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  t.f.fw.setEndstopState({homing:initial==='sampling'?1:0,pin_value:initial==='triggered'?1:0,next_clock:0},7);
  const before=t.f.fw.outputs.length;
  await assert.rejects(t.port.probeZ(0,5,t.groups,s),/already triggered or sampling/);
  const output=t.f.fw.outputs.slice(before);assert(output.some(m=>m.name==='endstop_query_state'));
  assert(!output.some(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0));
  assert(!output.some(m=>m.name==='queue_step'));assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
test('native sample session retains exclusive ownership across retract and second seek',async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{z_offset:'.123456789',x_offset:'-20',y_offset:'3',samples:'2',samples_tolerance:'10'}),s=new AbortController().signal;let hits=0,retracted=false,motionAtHit=0;const handled=new Set<unknown>();
 const timer=setInterval(()=>{
  if(hits===1&&!retracted){if(t.f.fw.outputs.findLastIndex(m=>m.name==='reset_step_clock')>t.f.fw.outputs.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)&&t.f.fw.motion.length>motionAtHit){retracted=true;t.f.fw.setTriggerReason(2,8);t.f.fw.setStepperPosition(2,185);}}
  const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0&&!handled.has(m));if(!arm)return;
  const hit=Number(arm.parameters.clock)+50000;if(BigInt(t.f.fw.currentClock())<BigInt(hit+1000))return;
  handled.add(arm);hits++;motionAtHit=t.f.fw.motion.length;t.f.fw.setTriggerReason(1,8);t.f.fw.setStepperPosition(2,hits===1?-15:170);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});
 },1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);
  const running=t.port.measureProbe(0,s);
  assert.throws(()=>t.port.move([50,0,2,2],5),/busy/);
  const result=await running;assert.equal(hits,2);assert.equal(result.samples.length,2);assert.equal(result.attempts,2);assert.deepEqual(result.bedPosition,[30,3,result.position[2]-.123456789]);assert.equal(t.port.status.failed,false);assert.equal(t.kinematics.status.homedAxes,'xyz');
 }finally{clearInterval(timer);await t.close();}
});
