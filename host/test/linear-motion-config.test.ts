import test from 'node:test';
import assert from 'node:assert/strict';
import {readLinearMotionConfiguration,createConfiguredNativeLinearPort} from '../src/config/linear-motion.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
const defaults=(overrides:Record<string,Record<string,string>>={})=>{
 const sections:Record<string,Record<string,string>>={printer:{kinematics:'cartesian',max_velocity:'100',max_accel:'1000'},extruder:{nozzle_diameter:'.4',filament_diameter:'1.75'}};
 for(const name of ['stepper_x','stepper_y','stepper_z'])sections[name]={position_max:'200',position_endstop:'0'};
 for(const [name,values] of Object.entries(overrides))sections[name]={...sections[name],...values};return new ConfigurationReader(new ConfigurationSource('/defaults.cfg',sections,[]),null);
};
test('linear config preserves Python motion, extrusion and homing defaults without granting homing',()=>{
 const c=readLinearMotionConfiguration(defaults());assert.equal(c.kinematics.status.homedAxes,'');assert.deepEqual(c.kinematics.status.axisMaximum,[200,200,200]);
 assert.equal(c.limits.maxVelocity,100);assert.equal(c.limits.maxAccel,1000);assert.equal(c.limits.mcrPseudoAccel,500);assert.equal(c.limits.junctionDeviation,25*(Math.sqrt(2)-1)/1000);
 assert.deepEqual(c.rails[0],{endstop:0,positiveDirection:false,speed:5,secondSpeed:2.5,retractSpeed:5,retractDistance:5});
 assert.equal(c.extrusion.limits.maxDistance,50);assert.equal(c.extrusion.limits.instantCornerVelocity,1);assert(Math.abs(c.extrusion.limits.maxVelocity-(4096/(49*Math.PI)))<1e-12);assert(Math.abs(c.extrusion.limits.maxAccel-c.extrusion.limits.maxVelocity*10)<1e-12);
});
test('explicit cross section does not raise default extrusion-only speed or acceleration',()=>{
 const original=readLinearMotionConfiguration(defaults()),raised=readLinearMotionConfiguration(defaults({extruder:{max_extrude_cross_section:'20'}}));assert.equal(raised.extrusion.limits.maxVelocity,original.extrusion.limits.maxVelocity);assert.equal(raised.extrusion.limits.maxAccel,original.extrusion.limits.maxAccel);assert.equal(raised.extrusion.limits.maxCrossSection,20);
});
test('homing direction uses exact quarter-range boundaries and requires explicit middle direction',()=>{
 for(const [endstop,direction] of [['50',false],['150',true]] as const)assert.equal(readLinearMotionConfiguration(defaults({stepper_x:{position_endstop:endstop}})).rails[0].positiveDirection,direction);
 assert.throws(()=>readLinearMotionConfiguration(defaults({stepper_x:{position_endstop:'100'}})),/infer/);
 assert.equal(readLinearMotionConfiguration(defaults({stepper_x:{position_endstop:'100',homing_positive_dir:'true'}})).rails[0].positiveDirection,true);
 for(const values of [{position_endstop:'0',homing_positive_dir:'true'},{position_endstop:'200',homing_positive_dir:'false'}])assert.throws(()=>readLinearMotionConfiguration(defaults({stepper_x:values})),/conflicts/);
});
test('all supported linear kinematics accept explicit machine limits and independently scoped rails',()=>{
 for(const kind of ['cartesian','corexy','corexz','hybrid_corexy','hybrid_corexz']){
  const c=readLinearMotionConfiguration(linearMotionReader({printer:{kinematics:kind,square_corner_velocity:'0',minimum_cruise_ratio:'.75'},stepper_y:{homing_speed:'8',second_homing_speed:'3',homing_retract_speed:'7',homing_retract_dist:'2'}}));
  assert.equal(c.kinematics.kind,kind);assert.equal(c.limits.junctionDeviation,0);assert.equal(c.limits.mcrPseudoAccel,250);assert.equal(c.rails[1].secondSpeed,3);assert.equal(c.rails[1].retractSpeed,7);assert.equal(c.rails[0].speed,10);assert.equal(c.extrusion.limits.maxVelocity,30);
 }
});
test('invalid ranges, speed limits, diameters and overflow reject before hardware access',()=>{
 const cases:Record<string,Record<string,string>>[]=[{printer:{kinematics:'delta'}},{printer:{max_z_velocity:'101'}},{printer:{minimum_cruise_ratio:'1'}},{printer:{square_corner_velocity:'1e308'}},{stepper_x:{position_max:'0'}},{stepper_x:{position_endstop:'201'}},{stepper_x:{homing_speed:'5e-324'}},{extruder:{filament_diameter:'.1'}},{extruder:{nozzle_diameter:'1e200',filament_diameter:'1e200'}}];
 for(const values of cases){let accessed=false;assert.throws(()=>createConfiguredNativeLinearPort(defaults(values),{get generation(){accessed=true;throw new Error('hardware touched');}} as never));assert.equal(accessed,false);}
});
test('configured solver mismatch rejects before a native port takes ownership',()=>{
 let accessed=false;assert.throws(()=>createConfiguredNativeLinearPort(defaults({printer:{kinematics:'corexy'}}),{kinematicIds:['x','y','z'],emitters:[{id:'x',mode:'x'},{id:'y',mode:'y'},{id:'z',mode:'z'}],get generation(){accessed=true;throw new Error('hardware touched');}} as never),/rail solvers/);assert.equal(accessed,false);
});
