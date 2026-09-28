// Delta rail defaults from klippy/kinematics/delta.py and stepper.py.
// Copyright (C) 2016-2021 Kevin O'Connor. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {DeltaKinematics,type DeltaConfig} from '../kinematics/delta.ts';
import type {Vec3} from '../math/mathutil.ts';
import {motionLimits} from '../motion/lookahead.ts';
import {readStepperDistance} from './stepper.ts';
/** Cold configuration only: does not grant homing or claim pins/MCU resources. */
export function readDeltaMotionConfiguration(reader:ConfigurationReader){
 const printer=reader.section('printer');if(printer.get('kinematics')!=='delta')throw new Error('Expected delta kinematics');
 const maxVelocity=printer.getFloat('max_velocity',{above:0}),maxAccel=printer.getFloat('max_accel',{above:0});
 const velocitySettings=Object.freeze({squareCornerVelocity:printer.getFloat('square_corner_velocity',{defaultValue:5,minval:0}),minCruiseRatio:printer.getFloat('minimum_cruise_ratio',{defaultValue:.5,minval:0,below:1})});
 const limits=motionLimits(maxVelocity,maxAccel,velocitySettings.squareCornerVelocity,velocitySettings.minCruiseRatio);
 if(!Number.isFinite(maxVelocity*maxVelocity)||maxVelocity*maxVelocity<=0||!Number.isFinite(limits.junctionDeviation)||!Number.isFinite(limits.mcrPseudoAccel))throw new Error('Delta motion arithmetic overflow');
 const radius=printer.getFloat('delta_radius',{above:0}),a=reader.section('stepper_a');
 const defaultArm=a.getFloat('arm_length',{above:radius}),defaultEndstop=a.getFloat('position_endstop',{minval:0});
 const rails=(['a','b','c'] as const).map((id,index)=>{
  const section='stepper_'+id,c=reader.section(section),distance=readStepperDistance(c);
  const armLength=c.getFloat('arm_length',{defaultValue:defaultArm,above:radius}),angle=c.getFloat('angle',{defaultValue:[210,330,90][index]});
  const endstop=c.getFloat('position_endstop',{defaultValue:defaultEndstop,minval:0});
  const configuredDirection=c.getBoolean('homing_positive_dir',{defaultValue:null}),positiveDirection=configuredDirection??endstop!==0;
  if(configuredDirection!==null&&(positiveDirection&&endstop===0||!positiveDirection))throw new Error('Delta homing direction conflicts with endstop');
  const speed=c.getFloat('homing_speed',{defaultValue:5,above:0});
  const homing=Object.freeze({endstop,positiveDirection,speed,secondSpeed:c.getFloat('second_homing_speed',{defaultValue:speed/2,above:0}),retractSpeed:c.getFloat('homing_retract_speed',{defaultValue:speed,above:0}),retractDistance:c.getFloat('homing_retract_dist',{defaultValue:5,minval:0})});
  if(!Number.isFinite(homing.secondSpeed)||homing.secondSpeed<=0)throw new Error('Unrepresentable Delta second homing speed');
  return Object.freeze({section,id,armLength,angle,distance,homing});
 });
 const triple=(get:(rail:typeof rails[number])=>number):Vec3=>[get(rails[0]),get(rails[1]),get(rails[2])];
 const config:DeltaConfig={radius,printRadius:printer.getFloat('print_radius',{defaultValue:radius,above:0}),arms:triple(r=>r.armLength),angles:triple(r=>r.angle),endstops:triple(r=>r.homing.endstop),stepDistances:triple(r=>r.distance.stepDistance),minimumZ:printer.getFloat('minimum_z_position',{defaultValue:0,maxval:Math.min(...rails.map(r=>r.homing.endstop))}),maxVelocity,maxAccel,maxZVelocity:printer.getFloat('max_z_velocity',{defaultValue:maxVelocity,above:0,maxval:maxVelocity}),maxZAccel:printer.getFloat('max_z_accel',{defaultValue:maxAccel,above:0,maxval:maxAccel})};
 const kinematics=new DeltaKinematics(config),geometry=kinematics.solverGeometry;
 return Object.freeze({kinematics,limits:Object.freeze(limits),velocitySettings,rails:Object.freeze(rails.map((rail,index)=>Object.freeze({...rail,mode:geometry[index]})))});
}
