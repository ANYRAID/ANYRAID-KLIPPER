import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {readNativeBedMesh} from '../src/config/native-bed-mesh.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
test('native mesh offsets preserve physical position, affect actual steps and reset on profile load',async()=>{
 const config=readNativeBedMesh(linearMotionReader({bed_mesh:{fade_start:'1',fade_end:'3',fade_target:'0'},'bed_mesh slope':{version:'1',min_x:'40',max_x:'50',min_y:'0',max_y:'100',x_count:'2',y_count:'2',mesh_x_pps:'0',mesh_y_pps:'0',algo:'direct',tension:'.2',points:'0,1\n0,1'}}))!;
 const t=await nativeLinearFixture(),output:string[]=[],g=new NativeLinearGCode(t.port,t.kinematics,rails,m=>output.push(m),5000,1,undefined,undefined,config),s=new AbortController().signal;
 try{
  t.kinematics.markHomed([0,1,2]);await t.port.forcePosition([50,0,2,2],s);g.coordinates.resetPosition();g.enable();await g.dispatch.execute('BED_MESH_OFFSET X=10');assert(output.some(m=>m.includes('No mesh loaded')));
  for(const command of ['BED_MESH_OFFSET X=NaN','BED_MESH_OFFSET ZFADE=Infinity','BED_MESH_OFFSET Z=1'])await assert.rejects(g.dispatch.execute(command),/Invalid BED_MESH_OFFSET/);
  await g.dispatch.execute('BED_MESH_PROFILE LOAD=slope');const before=t.f.fw.motion.length;
  await g.dispatch.execute('BED_MESH_OFFSET X=-10 ZFADE=1');assert.deepEqual(t.port.homingPosition(),[50,0,2,2]);assert.deepEqual(g.coordinates.state.position,[50,0,2,2]);assert.equal(t.port.currentBedMesh()!.calcZ(50,0),0);assert.equal(t.f.fw.motion.length,before);assert.equal(g.bedMeshStatus!().profile_name,'slope');
  await g.dispatch.execute('BED_MESH_OFFSET Y=10');assert.equal(t.port.currentBedMesh()!.calcZ(50,0),0);
  await g.dispatch.execute('G1 X51 Z2 F600');assert.deepEqual(t.port.homingPosition(),[51,0,2,2]);
  await g.dispatch.execute('BED_MESH_OFFSET ZFADE=0');const motion=t.f.fw.motion.length;
  await g.dispatch.execute('G1 Z2 F600');assert.deepEqual(t.port.homingPosition(),[51,0,2.05,2]);assert.equal(t.f.fw.motion.slice(motion).filter(m=>m.name==='queue_step'&&m.parameters.oid===2).reduce((n,m)=>n+Number(m.parameters.count),0),5);
  await g.dispatch.execute('BED_MESH_PROFILE LOAD=slope');assert.equal(t.port.currentBedMesh()!.calcZ(51,0),1);await g.dispatch.execute('G1 Z2 F600');assert.deepEqual(t.port.homingPosition(),[51,0,2.5,2]);assert.equal(t.f.stops,0);
 }finally{await g.close();await t.close();}
});
