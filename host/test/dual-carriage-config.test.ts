import test from 'node:test';
import assert from 'node:assert/strict';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {readLinearMotionConfiguration,createConfiguredNativeLinearPort} from '../src/config/linear-motion.ts';
import {carriageSolvers,nativeCarriageTransforms,dualCarriagePosition,type CarriageTopology} from '../src/kinematics/dual-carriage-projection.ts';
import type {CarriagePair} from '../src/kinematics/dual-carriage.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const second={axis:'x',position_min:'10',position_max:'220',position_endstop:'220'};
const reader=(kind='cartesian',values:Record<string,string>={})=>linearMotionReader({printer:{kinematics:kind},stepper_x:{position_max:'200',position_endstop:'0'},dual_carriage:{...second,...values}});
test('dual carriage config preserves physical rails, safe distance and homing defaults',()=>{
 const c=readLinearMotionConfiguration(reader());assert.equal(c.kinematics.status.homedAxes,'');const d=c.dualCarriage!;
 assert.equal(d.axis,0);assert.equal(d.safeDistance,10);assert.deepEqual(d.homingOrder,[0,1]);
 assert.deepEqual(d.secondHoming,{endstop:220,positiveDirection:true,speed:5,secondSpeed:2.5,retractSpeed:5,retractDistance:5});
 assert.equal(readLinearMotionConfiguration(reader('cartesian',{axis:'y',safe_distance:'0'})).dualCarriage!.axis,1);
 for(const kind of ['hybrid_corexy','hybrid_corexz']){const config=readLinearMotionConfiguration(reader(kind));assert.equal(config.dualCarriage!.axis,0);assert.throws(()=>readLinearMotionConfiguration(reader(kind,{axis:'y'})));}
});
test('unsupported, ambiguous or unrepresentable carriage config fails before taking hardware',()=>{
 for(const kind of ['corexy','corexz'])assert.throws(()=>readLinearMotionConfiguration(reader(kind)),/requires/);
 for(const v of [{axis:'z'},{position_max:'10'},{position_endstop:'999'},{position_endstop:'100'},{safe_distance:'-1'},{homing_speed:'5e-324'},{position_endstop:'10',homing_positive_dir:'true'},{position_endstop:'0',position_min:'0',homing_positive_dir:'false'}] as Record<string,string>[])assert.throws(()=>readLinearMotionConfiguration(reader('cartesian',v)));
 let touched=false;assert.throws(()=>createConfiguredNativeLinearPort(reader(),{get generation(){touched=true;throw new Error('touched');}} as never),/ownership/);assert.equal(touched,false);
});
test('each primary carriage exactly inverts its native hybrid or Cartesian solver',()=>{
 const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
 for(const topology of [{kind:'cartesian',axis:0},{kind:'cartesian',axis:1},{kind:'hybrid_corexy',axis:0},{kind:'hybrid_corexz',axis:0}] as CarriageTopology[])for(const primary of [0,1]){
  const pair:CarriagePair=primary===0?[{mode:'PRIMARY',scale:1,offset:4},{mode:'MIRROR',scale:-1,offset:180}]:[{mode:'COPY',scale:1,offset:-80},{mode:'PRIMARY',scale:1,offset:4}];
  const modes=carriageSolvers(topology),transforms=nativeCarriageTransforms(topology,pair);
  using q=new TrapQueue();using first=q.createStepper(settings,modes[0],.01);using second=q.createStepper(settings,modes[1],.01);first.configureCarriage(transforms[0]);second.configureCarriage(transforms[1]);
  for(let i=0;i<2500;i++){
   const xyz:[number,number,number]=[(i%256)/8,(i%97)/8,(i%47)/8],motors=[...xyz,second.coordinatePosition(...xyz)];motors[topology.axis]=first.coordinatePosition(...xyz);
   assert.deepEqual(dualCarriagePosition(topology,pair,motors),xyz);
  }
 }
});
test('readback rejects missing primary, invalid topology and overflow',()=>{
 const t:CarriageTopology={kind:'hybrid_corexy',axis:0},inactive={mode:'INACTIVE',scale:0,offset:0} as const,primary={mode:'PRIMARY',scale:1,offset:0} as const;
 assert.throws(()=>dualCarriagePosition(t,[inactive,inactive],[0,0,0,0]),/primary/);assert.throws(()=>dualCarriagePosition(t,[primary,primary],[0,0,0,0]),/primary/);
 assert.throws(()=>dualCarriagePosition(t,[primary,inactive],[1e308,1e308,0,0]),/overflow/);assert.throws(()=>carriageSolvers({...t,axis:1}),/topology/);
});
