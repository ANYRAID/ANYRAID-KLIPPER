// Stepper/filter assembly from stepper.py, input_shaper.py and extruder.py.
// GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {compileConfiguredHardware} from './hardware.ts';
import type {StoppedEmitter} from '../homing/rebuild-motion.ts';
import {inputShaper,parseShaperName,shaperConfigs,type Shaper} from '../motion/shaper.ts';
export interface ConfiguredMotionRequest {emitter:string;queueId:string;mode:StoppedEmitter['mode']}
/** Produce recovery-compatible descriptors from the same stepper/OID/clock
 * owners used by hardware startup. No native allocation, IO or position grant.
 * Explicit solver/queue routing is required for coupled and extra motors. */
export function compileConfiguredMotionEmitters(reader:ConfigurationReader,hardware:ReturnType<typeof compileConfiguredHardware>,requests:readonly ConfiguredMotionRequest[]):readonly StoppedEmitter[]{
 if(!requests.length||requests.length!==hardware.steppers.length||new Set(requests.map(r=>r.emitter)).size!==requests.length)throw new Error('Motion descriptors must cover every configured stepper');
 const shapers:Partial<Record<'x'|'y'|'z',Shaper>>={};
 if(reader.hasSection('input_shaper')){
  const section=reader.section('input_shaper'),base=section.get('shaper_type',{defaultValue:'mzv'});
  for(const axis of ['x','y'] as const){
   const parsed=parseShaperName(section.get(`shaper_type_${axis}`,{defaultValue:base})),frequency=section.getFloat(`shaper_freq_${axis}`,{defaultValue:0,minval:0}),damping=section.getFloat(`damping_ratio_${axis}`,{defaultValue:.1,minval:0,maxval:shaperConfigs[parsed.name].maxDamping});
   const shape=inputShaper(parsed.name,frequency,damping,parsed.options);if(frequency){Object.freeze(shape.amplitudes);Object.freeze(shape.times);shapers[axis]=Object.freeze(shape);}
  }
 }
 Object.freeze(shapers);const queueKinds=new Map<string,boolean>();
 return Object.freeze(requests.map(request=>{
  const step=hardware.steppers.find(s=>s.emitter===request.emitter);if(!step||typeof request.queueId!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(request.queueId))throw new Error('Unknown motion emitter or invalid queue');
  const mode=typeof request.mode==='object'?Object.freeze({...request.mode}):request.mode;
  if(typeof mode==='object'){if(mode.kind!=='delta'||![mode.armLength,mode.towerX,mode.towerY].every(Number.isFinite)||mode.armLength<=0)throw new Error('Invalid delta emitter geometry');}
  else if(!['x','y','z','corexy+','corexy-','corexz+','corexz-','extruder'].includes(mode))throw new Error('Unsupported motion solver');
  const extrusion=mode==='extruder',prior=queueKinds.get(request.queueId);if(prior!==undefined&&prior!==extrusion)throw new Error('Extrusion and kinematics cannot share a motion queue');queueKinds.set(request.queueId,extrusion);
  const owner=[...hardware.motors.lines,...hardware.motors.alwaysOn].find(m=>m.emitters.includes(step.emitter));if(!owner||owner.mcu!==step.mcu)throw new Error('Missing motion clock owner');
  const section=reader.section(step.section),pressureAdvance=extrusion?Object.freeze({advance:section.getFloat('pressure_advance',{defaultValue:0,minval:0}),smoothTime:section.getFloat('pressure_advance_smooth_time',{defaultValue:.04,above:0,maxval:.2})}):undefined;
  return Object.freeze({id:step.emitter,queueId:request.queueId,member:step.physicalMember,settings:Object.freeze({...step.compressor,frequency:owner.clock.frequency,timeOffset:owner.clock.offset}),mode,rotationDistance:step.rotationDistance,stepsPerRotation:step.stepsPerRotation,...extrusion?{pressureAdvance}:{shapers}});
 }));
}
