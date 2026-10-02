import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture,nativeStreamStarted} from './helpers/native-linear-port.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {readNativeBedMesh} from '../src/config/native-bed-mesh.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
for(const fade of [false,true])test(`nonplanar native mesh preserves exact final pulses through an active pause (fade=${fade})`,async()=>{
 const config=readNativeBedMesh(linearMotionReader({bed_mesh:{fade_start:'1',fade_end:fade?'3':'0',fade_target:'0',split_delta_z:'.01',move_check_distance:'3'},'bed_mesh slope':{version:'1',min_x:'0',max_x:'100',min_y:'0',max_y:'20',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'0,.1\n.4,.2'}}))!;
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,undefined,config),s=new AbortController().signal;let running:Promise<void>|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);g.coordinates.resetPosition();g.enable();await g.dispatch.execute('BED_MESH_PROFILE LOAD=slope');
  const targetZ=fade?2:1,expectedPhysicalZ=targetZ+(fade?.5:1)*(.5*.4+.5*.2),before=t.f.fw.motion.length;let completed=false;
  running=g.dispatch.execute(`G1 Y20 Z${targetZ} F600`).then(()=>{completed=true;});void running.catch(()=>{});await nativeStreamStarted(t);const stopped=await t.port.pauseStream(s);
  assert.equal(completed,false);assert(stopped.position[1]>0&&stopped.position[1]<20);assert(stopped.position[2]>=1&&stopped.position[2]<expectedPhysicalZ);assert.deepEqual(t.port.position(),[50,20,targetZ,2]);assert.equal(t.port.bedMeshStatus.profile_name,'slope');
  await t.port.resumeStream(s);await running;await t.port.drain(s);assert.deepEqual(t.port.homingPosition(),[50,20,expectedPhysicalZ,2]);assert.deepEqual(g.coordinates.state.position,[50,20,targetZ,2]);
  const direction=new Map<number,number>();for(const packet of t.f.fw.motion.slice(before)){const oid=Number(packet.parameters.oid);if(packet.name==='set_next_step_dir')direction.set(oid,Number(packet.parameters.dir));else if(packet.name==='queue_step')assert.equal(direction.get(oid),1,'This monotonic path must emit positive steps');}
  const packets=t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step'),pulses=(oid:number)=>packets.filter(m=>m.parameters.oid===oid).reduce((sum,m)=>sum+Number(m.parameters.count),0);
  assert.equal(pulses(1),2000);assert.equal(pulses(2),fade?115:30);assert.equal(pulses(3),0);assert.equal(pulses(4),0);assert.equal(t.f.stops,0);
 }finally{await g.close();await running?.catch(()=>{});await t.close();}
});

for(const failure of ['invalid-fade','cancelled'] as const)test(`rejected native mesh transition retains its previous published state (${failure})`,async()=>{
 const config=readNativeBedMesh(linearMotionReader({bed_mesh:{},'bed_mesh saved':{version:'1',min_x:'0',max_x:'100',min_y:'0',max_y:'100',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'.2,.2\n.2,.2'}}))!;
 const t=await nativeLinearFixture(),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,1,2],s);const mesh=config.profiles.load('saved');await t.port.replaceBedMesh(mesh,{},s,'original');const prior=t.port.bedMeshStatus,before=t.f.fw.motion.length,cancel=new AbortController();if(failure==='cancelled')cancel.abort(new Error('cancel mesh transition'));
  await assert.rejects(t.port.replaceBedMesh(mesh,failure==='invalid-fade'?{fadeConfig:{start:0,end:.01}}:{},cancel.signal,'replacement'));
  assert.equal(t.port.bedMeshStatus,prior);assert.equal(t.port.bedMeshStatus.profile_name,'original');assert.deepEqual(t.port.homingPosition(),[50,0,1,2]);assert.equal(t.f.fw.motion.length,before);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
