import test from 'node:test';
import assert from 'node:assert/strict';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {readLinearMotionConfiguration} from '../src/config/linear-motion.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
import {DualCarriageLinearKinematics} from '../src/kinematics/dual-carriage-linear.ts';
import {nativeCarriageTransforms} from '../src/kinematics/dual-carriage-projection.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const initial=[{mode:'PRIMARY',scale:1,offset:0},{mode:'INACTIVE',scale:0,offset:180}] as const,geometry={kind:'cartesian',axis:0,rails:[{minimum:0,maximum:200,endstop:0,positiveDirection:false},{minimum:10,maximum:220,endstop:220,positiveDirection:true}],safeDistance:10} as const;
 const transforms=nativeCarriageTransforms(geometry,initial),f=await rebuiltFixture(true,true,false,false,false,0,transforms.map((transform,i)=>({id:i?'x2':'x',transform})));
 try{
  const generation=await bindRebuiltMotion(f.options),config=readLinearMotionConfiguration(linearMotionReader()),kinematics=new DualCarriageLinearKinematics({kind:'cartesian',ranges:[[0,200],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100},geometry,initial);
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}],second=[{...groups[0],endstop:f.secondEndstop,members:[{...groups[0].members[0],trigger:f.secondTrigger}]}];
  const port=new NativeLinearHomingPort({generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],carriages:{emitterIds:['x','x2'],groups:[groups,second]},limits:config.limits,extrusion:config.extrusion,canExtrude:()=>false});
  return {f,port,kinematics,async close(){await port.dispose();await f.close();}};
 }catch(e){await f.close();throw e;}
}
test('native port publishes primary only after exclusive rebase and applies second rail limits',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0,1,2]);const before=t.f.fw.motion.length;
  const pending=t.port.setCarriageMode(1,'PRIMARY',signal());assert.equal(t.port.status.phase,'carriage');assert.equal(t.port.carriageStatus!.primary,0);assert.throws(()=>t.port.move([51,0,0,2],10),/busy/);
  await pending;assert.equal(t.port.carriageStatus!.primary,1);assert.deepEqual(t.port.position(),[180,0,0,2]);assert.equal(t.f.fw.motion.length,before);
  assert.deepEqual(t.port.carriageStatus!.homed,[true,false]);assert.equal(t.kinematics.status.homedAxes,'yz');t.kinematics.markHomed([0]);
  t.port.move([180.1,0,0,2],10);await t.port.drain(signal());
  const steps=t.f.fw.motion.filter(m=>m.name==='queue_step');assert.equal(steps.filter(m=>m.parameters.oid===3).length,0);assert.equal(steps.filter(m=>m.parameters.oid===5).reduce((n,m)=>n+Number(m.parameters.count),0),10);
  assert.equal(t.kinematics.status.axisMaximum[0],220);assert.deepEqual(t.kinematics.calcPosition([180,0,0]),[180,0,0]);
  // The parked first carriage at 50 requires the active second to remain >=60.
  assert.throws(()=>t.port.move([59,0,0,2],10),/range/);
 }finally{await t.close();}
});
test('copy and mirror update movement admission without granting homing',async()=>{
 for(const mode of ['COPY','MIRROR'] as const){const t=await fixture();try{
  assert.throws(()=>t.port.setCarriageMode(1,mode,signal()),/homed/);assert.equal(t.port.status.failed,false);assert.equal(t.kinematics.status.homedAxes,'');
  t.kinematics.markHomed([0,1,2]);assert.throws(()=>t.port.setCarriageMode(1,mode,signal()),/homed/);
  await t.port.setCarriageMode(1,'PRIMARY',signal());t.kinematics.markHomed([0]);await t.port.setCarriageMode(0,'PRIMARY',signal());
  await t.port.setCarriageMode(1,mode,signal());assert.equal(t.port.carriageStatus!.carriages[1].mode,mode);assert.deepEqual(t.port.position(),[50,0,0,2]);
  t.port.move([50.1,0,0,2],10);await t.port.drain(signal());
  for(const oid of [3,5])assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),10);
  const directions=[3,5].map(oid=>t.f.fw.motion.find(m=>m.name==='set_next_step_dir'&&m.parameters.oid===oid)!.parameters.dir);assert.equal(directions[0]===directions[1],mode==='COPY');
  assert.throws(()=>t.port.move([mode==='COPY'?91:111,0,0,2],10),/range/);
 }finally{await t.close();}}
});
test('failed stop leaves old carriage state and clears all homing authority',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0,1,2]);t.f.fw.setTriggerReason(4);await assert.rejects(t.port.setCarriageMode(1,'PRIMARY',signal()));
  assert.equal(t.port.carriageStatus!.primary,0);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.throws(()=>t.port.move([51,0,0,2],10),/stopped/);
 }finally{await t.close();}
});
