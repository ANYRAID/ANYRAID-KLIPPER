import {readBedTilt} from './bed-tilt.ts';
import {readSafeZHoming} from './safe-z-home.ts';
// Linear machine limits and homing defaults from klippy/toolhead.py,
// stepper.py and kinematics/extruder.py. GPL-3.0-or-later.
import {readProbeConfiguration} from './probe.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {LinearKinematics,type LinearConfig,type Axis,type Range} from '../kinematics/linear.ts';
import {motionLimits} from '../motion/lookahead.ts';
import {ExtrusionGuard} from '../motion/extrusion.ts';
import type {LinearHomingRail} from '../homing/linear-command.ts';
import {NativeLinearHomingPort,type NativeLinearPortOptions} from '../homing/native-linear-port.ts';
/** Configuration only. Pin/OID ownership, step distances, sensors, and native
 * solver allocation must be supplied by the machine hardware assembly. */
export function readLinearMotionConfiguration(reader:ConfigurationReader){
 const printer=reader.section('printer'),kind=printer.get('kinematics');
 const probeZ=reader.section('stepper_z').get('endstop_pin',{defaultValue:''})==='probe:z_virtual_endstop',probe=probeZ?readProbeConfiguration(reader):undefined;
 if(probeZ&&!probe)throw new Error('Probe Z homing requires a configured probe');
 if(probeZ&&reader.section('stepper_z').hasOption('position_endstop'))throw new Error('Probe Z homing uses probe z_offset, not position_endstop');
 if(probeZ&&reader.sections().some(n=>/^endstop_phase stepper_z(?:[1-9][0-9]*)?$/.test(n)))throw new Error('Probe Z homing cannot use endstop phase correction');
 if(kind!=='cartesian'&&kind!=='corexy'&&kind!=='corexz')throw new Error('Unsupported linear kinematics');
 const maxVelocity=printer.getFloat('max_velocity',{above:0}),maxAccel=printer.getFloat('max_accel',{above:0});
 const velocitySettings=Object.freeze({squareCornerVelocity:printer.getFloat('square_corner_velocity',{defaultValue:5,minval:0}),minCruiseRatio:printer.getFloat('minimum_cruise_ratio',{defaultValue:.5,minval:0,below:1})});
 const limits=motionLimits(maxVelocity,maxAccel,velocitySettings.squareCornerVelocity,velocitySettings.minCruiseRatio);
 if(!Number.isFinite(limits.junctionDeviation)||!Number.isFinite(limits.mcrPseudoAccel))throw new Error('Motion limit arithmetic overflow');
 const ranges:Range[]=[],rails:Omit<LinearHomingRail,'endstops'>[]=[];
 for(const name of ['stepper_x','stepper_y','stepper_z']){
  const section=reader.section(name),low=section.getFloat('position_min',{defaultValue:0}),high=section.getFloat('position_max',{above:low}),endstop=name==='stepper_z'&&probeZ?probe!.offsets[2]:section.getFloat('position_endstop',{minval:low,maxval:high}),length=high-low;
  if(endstop<low||endstop>high)throw new Error('Endstop must be within axis range');
  if(!Number.isFinite(length))throw new Error('Axis range arithmetic overflow');
  let positiveDirection=section.getBoolean('homing_positive_dir',{defaultValue:null});
  if(positiveDirection===null){if(endstop<=low+length/4)positiveDirection=false;else if(endstop>=high-length/4)positiveDirection=true;else throw new Error(`Unable to infer homing direction for ${name}`);}
  if(name==='stepper_z'&&probeZ&&positiveDirection)throw new Error('Probe Z homing must descend');
  if(positiveDirection&&endstop===low||!positiveDirection&&endstop===high)throw new Error('Homing direction conflicts with endstop');
  const speed=section.getFloat('homing_speed',{defaultValue:5,above:0});
  ranges.push(Object.freeze([low,high] as const));rails.push(Object.freeze({endstop,positiveDirection,speed,secondSpeed:section.getFloat('second_homing_speed',{defaultValue:speed/2,above:0}),retractSpeed:section.getFloat('homing_retract_speed',{defaultValue:speed,above:0}),retractDistance:section.getFloat('homing_retract_dist',{defaultValue:5,minval:0})}));
 }
 const config:LinearConfig={kind,ranges:ranges as unknown as LinearConfig['ranges'],maxVelocity,maxAccel,maxZVelocity:printer.getFloat('max_z_velocity',{defaultValue:maxVelocity,above:0,maxval:maxVelocity}),maxZAccel:printer.getFloat('max_z_accel',{defaultValue:maxAccel,above:0,maxval:maxAccel})};
 const kinematics=new LinearKinematics(config);
 for(const [i,r] of rails.entries()){const geometry=kinematics.homingMove(i as Axis,r.endstop,r.positiveDirection);if(geometry.home[i]===geometry.force[i]||![r.speed,r.secondSpeed,r.retractSpeed].every(v=>Number.isFinite(v)&&v>0))throw new Error('Unrepresentable homing configuration');}
 const extruder=reader.section('extruder'),nozzleDiameter=extruder.getFloat('nozzle_diameter',{above:0}),filamentDiameter=extruder.getFloat('filament_diameter',{minval:nozzleDiameter}),defaultCrossSection=4*nozzleDiameter**2,defaultRatio=defaultCrossSection/(Math.PI*(filamentDiameter*.5)**2);
 // Extrude-only defaults use the DEFAULT cross section, even when the configured
 // maximum cross section is overridden. Preserve Python's numerical contract.
 const extrusion=new ExtrusionGuard({nozzleDiameter,filamentDiameter,maxCrossSection:extruder.getFloat('max_extrude_cross_section',{defaultValue:defaultCrossSection,above:0}),maxVelocity:extruder.getFloat('max_extrude_only_velocity',{defaultValue:maxVelocity*defaultRatio,above:0}),maxAccel:extruder.getFloat('max_extrude_only_accel',{defaultValue:maxAccel*defaultRatio,above:0}),maxDistance:extruder.getFloat('max_extrude_only_distance',{defaultValue:50,minval:0}),instantCornerVelocity:extruder.getFloat('instantaneous_corner_velocity',{defaultValue:1,minval:0})});
 return {bedTilt:readBedTilt(reader)?.tilt,safeZHoming:readSafeZHoming(reader,kinematics.status),probeHoming:probeZ?Object.freeze({minimumZ:ranges[2][0],offset:probe!.offsets[2]}):undefined,kinematics,limits:Object.freeze(limits),velocitySettings,extrusion,rails:Object.freeze(rails)};
}
export type ConfiguredLinearHardware=Omit<NativeLinearPortOptions,'kinematics'|'limits'|'extrusion'>&{endstopNames:readonly [readonly string[],readonly string[],readonly string[]]};
/** Validate machine semantics and solver identity before constructing the port.
 * Existing hardware ownership stays with the caller if validation fails. */
export function createConfiguredNativeLinearPort(reader:ConfigurationReader,hardware:ConfiguredLinearHardware){
 if(reader.hasSection('bltouch')&&!hardware.probeDevice)throw new Error('BLTouch requires an initialized native probe device');
 const config=readLinearMotionConfiguration(reader),expected=config.kinematics.kind==='cartesian'?['x','y','z']:config.kinematics.kind==='corexy'?['corexy+','corexy-','z']:['corexz+','y','corexz-'];
 if(hardware.kinematicIds.length!==3||new Set(hardware.kinematicIds).size!==3||hardware.kinematicIds.some((id,i)=>hardware.emitters.find(e=>e.id===id)?.mode!==expected[i]))throw new Error('Configured kinematics differs from native rail solvers');
 if(hardware.groupsByAxis.length!==3||hardware.endstopNames.length!==3)throw new Error('Three configured homing axes required');
 const rails=config.rails.map((rail,i)=>{
  const names=hardware.endstopNames[i];if(!names.length||names.length>16||names.length!==hardware.groupsByAxis[i].length||new Set(names).size!==names.length||names.some(n=>typeof n!=='string'||!n.length||n.length>128||/[\r\n\0]/.test(n)))throw new Error('Configured endstop names differ from homing groups');
  return Object.freeze({...rail,endstops:Object.freeze([...names])});
 });
 const port=new NativeLinearHomingPort({...hardware,...config,probeConfiguration:readProbeConfiguration(reader)});return {port,...config,rails:Object.freeze(rails)};
}
