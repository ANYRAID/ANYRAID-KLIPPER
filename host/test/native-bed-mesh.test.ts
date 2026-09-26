import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {readNativeBedMesh} from '../src/config/native-bed-mesh.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const configuration=()=>readNativeBedMesh(linearMotionReader({bed_mesh:{},'bed_mesh saved':{version:'1',min_x:'0',max_x:'100',min_y:'0',max_y:'100',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'.2,.2\n.2,.2'}}))!;
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
test('native saved mesh changes actual Z steps; parking is physical and clear preserves the physical endpoint',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,undefined,configuration()),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);g.coordinates.resetPosition();g.enable();
  assert.equal(g.bedMeshStatus!().profile_name,'');assert.deepEqual(Object.keys(g.bedMeshStatus!().profiles as object),['saved']);assert.equal(t.port.currentBedMesh(),null);await g.dispatch.execute('BED_MESH_PROFILE LOAD=saved');assert.equal(g.bedMeshStatus!().profile_name,'saved');assert.deepEqual(g.bedMeshStatus!().probed_matrix,[[.2,.2],[.2,.2]]);assert.deepEqual(t.port.position(),[50,0,.8,2]);assert.deepEqual(t.port.homingPosition(),[50,0,1,2]);
  const before=t.f.fw.motion.length;await g.dispatch.execute('G1 X51 Z1 F600\nM400');assert.deepEqual(t.port.position(),[51,0,1,2]);assert.deepEqual(t.port.homingPosition(),[51,0,1.2,2]);
  assert.equal(t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===2).reduce((sum,m)=>sum+Number(m.parameters.count),0),20);
  const paused=await t.port.pause(s);assert.deepEqual(paused.position,[51,0,1.2,2]);await assert.rejects(t.port.replaceBedMesh(null,{},s),/paused/);
  const lifted=[...paused.position];lifted[2]+=.1;t.port.validatePausedPath([{position:lifted,speed:5},{position:paused.position,speed:5}]);await t.port.movePaused(lifted,5,s);await t.port.movePaused(paused.position,5,s);await t.port.resumeStream(s);
  assert.deepEqual(g.coordinates.state.position,[51,0,1,2]);await g.dispatch.execute('BED_MESH_CLEAR');assert.deepEqual(g.coordinates.state.position,[51,0,1.2,2]);assert.equal(t.port.currentBedMesh(),null);assert.equal(g.bedMeshStatus!().profile_name,'');assert.equal(t.f.stops,0);
 }finally{await g.close();await t.close();}
});
test('native homing keeps other axes physical while preserving the selected mesh across rebase',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,undefined,configuration()),s=new AbortController().signal;let sent=false;
 const timer=setInterval(()=>{const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||sent)return;const clock=BigInt(Number(arm.parameters.clock));if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;sent=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});},1);
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);g.coordinates.resetPosition();g.enable();await g.dispatch.execute('BED_MESH_PROFILE LOAD=saved\nG28 X');assert(sent);assert.equal(t.port.homingPosition()[2],1);assert.equal(t.port.position()[2],.8);assert.equal(g.coordinates.state.position[2],.8);assert.equal(t.port.currentBedMesh()!.calcZ(51,0),.2);
 }finally{clearInterval(timer);await g.close();await t.close();}
});
test('mesh configuration is opt-in and rejects invalid split settings before hardware acquisition',()=>{
 assert.equal(readNativeBedMesh(linearMotionReader()),undefined);assert.throws(()=>readNativeBedMesh(linearMotionReader({bed_mesh:{split_delta_z:'0'}})));assert.throws(()=>readNativeBedMesh(linearMotionReader({bed_mesh:{move_check_distance:'2'}})));assert.throws(()=>configuration().profiles.load('unknown'));
});

test('mesh replacement drains queued old compensation before publishing the new inverse coordinates',async()=>{
 const t=await nativeLinearFixture(),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);const mesh=configuration().profiles.load('saved');await t.port.replaceBedMesh(mesh,{},s);t.coordinates.resetPosition();
  const before=t.f.fw.motion.length;t.coordinates.execute('G1',{X:51,Z:1,F:600});assert(t.port.status.pendingMoves>0);await t.port.replaceBedMesh(null,{},s);t.coordinates.resetPosition();
  assert.equal(t.port.status.pendingMoves,0);assert.deepEqual(t.coordinates.state.position,[51,0,1.2,2]);assert.equal(t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===2).reduce((sum,m)=>sum+Number(m.parameters.count),0),20);
 }finally{await t.close();}
});
