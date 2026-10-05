import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {BedMesh} from '../src/motion/bed-mesh.ts';
const grid={mesh:{min_x:50,max_x:50.01,min_y:0,max_y:.01,x_count:2,y_count:2,mesh_x_pps:0,mesh_y_pps:0,algo:'direct' as const,tension:.2},horizontalHeight:1,travelSpeed:10};
for(const circular of [false,true])test(`native grid measures without replacing old mesh; circular=${circular}`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{z_offset:'0'}),s=new AbortController().signal,handled=new Set<unknown>();let hits=0;
 const timer=setInterval(()=>{
  const output=t.f.fw.outputs,arm=output.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0&&!handled.has(m));
  if(!arm){if(hits&&output.findLastIndex(m=>m.name==='reset_step_clock')>output.findLastIndex(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0))t.f.fw.setTriggerReason(2,8);return;}
  const hit=Number(arm.parameters.clock)+50000;if(BigInt(t.f.fw.currentClock())<BigInt(hit+1000))return;
  handled.add(arm);hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setStepperPosition(2,-15*hits);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:hit+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:hit});
 },1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,0],s);const old=new BedMesh(grid.mesh,[[.1,.1],[.1,.1]]);await t.port.replaceBedMesh(old,{},s,'old');
  const active=circular?{...grid,circle:{radius:1,origin:[50,2] as const},mesh:{...grid.mesh,x_count:3,y_count:3}}:grid;const running=t.port.measureBedMesh(active,0,s);assert.throws(()=>t.port.move([50,0,2,0],5),/busy/);const mesh=await running;
  assert.equal(hits,circular?5:4);assert([...mesh.probedValues()].every(v=>Math.abs(v-.88)<1e-12));assert.equal(t.port.bedMeshStatus.profile_name,'old');assert.equal(t.port.homingPosition()[2],1);assert.equal(t.port.status.failed,false);
 }finally{clearInterval(timer);await t.close();}
});
for(const failure of ['range','reference','triggered'] as const)test(`failed native grid preserves old mesh (${failure})`,async()=>{
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,{z_offset:'0'}),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,0],s);await t.port.replaceBedMesh(new BedMesh(grid.mesh,[[.1,.1],[.1,.1]]),{},s,'old');
  const before=t.f.fw.motion.length;if(failure==='triggered')t.f.fw.setEndstopState({homing:0,pin_value:1,next_clock:0},7);
  await assert.rejects(t.port.measureBedMesh(failure==='range'?{...grid,mesh:{...grid.mesh,max_x:201}}:failure==='reference'?{...grid,zeroReference:[201,0]}:grid,0,s));
  if(failure!=='triggered')assert.equal(t.f.fw.motion.length,before);
  assert.equal(t.port.bedMeshStatus.profile_name,'old');assert.deepEqual([...t.port.currentBedMesh()!.probedValues()],[.1,.1,.1,.1]);assert(t.port.status.failed);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
