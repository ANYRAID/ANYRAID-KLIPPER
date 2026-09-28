import {readProbeGrid} from './probe-grid.ts';
import {configuredProbeSection,readProbeConfiguration} from './probe.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins} from '../protocol/pins.ts';
import {readDeltaMotionConfiguration} from './delta-motion.ts';
import {readHomingPin} from './sensorless.ts';
import {planPrinterPeripherals} from './printer-peripherals.ts';
import type {LinearPrinterPolicy} from './linear-printer.ts';
import type {HardwareLayout} from './hardware.ts';
import type {ConfiguredMotionRequest} from './motion-emitters.ts';
import {compileHomingGroups,type ConfiguredHomingGroup} from './linear-homing.ts';
/** Hardware/motion topology planning, including independent tower switches
 * and a separate all-motor mechanical probe group. No IO or homing authority. */
export function planDeltaHardware(reader:ConfigurationReader,policy:LinearPrinterPolicy){
 const config=readDeltaMotionConfiguration(reader),pins=new PrinterPins<object>();
 if(!policy.mcus.length||policy.mcus.length>16||new Set(policy.mcus).size!==policy.mcus.length||![policy.enableLeadTime,policy.fanMinimumScheduleTime].every(v=>Number.isFinite(v)&&v>0))throw new Error('Invalid Delta hardware policy');
 for(const id of policy.mcus)pins.register(id,{});
 const sections=reader.sections();
 if(sections.some(n=>n.startsWith('stepper_')&&!/^stepper_[abc](?:[1-9][0-9]*)?$/.test(n))||sections.some(n=>/^extruder[0-9]+$/.test(n)||n.startsWith('extruder_stepper ')))throw new Error('Unsupported Delta motor topology');
 const motors=config.rails.flatMap(rail=>sections.filter(n=>n===rail.section||new RegExp('^'+rail.section+'[1-9][0-9]*$').test(n)).sort((a,b)=>Number(a.slice(9)||0)-Number(b.slice(9)||0)).map(section=>({section,emitter:section.slice(8),tower:rail.id,mode:rail.mode as ConfiguredMotionRequest['mode']})));
 motors.push({section:'extruder',emitter:'e',tower:'a',mode:'extruder'});
 const owner=new Map(motors.map(m=>[m.emitter,pins.parse(reader.section(m.section).get('step_pin'),{canInvert:true}).chipName]));
 for(const motor of motors)if(pins.parse(reader.section(motor.section).get('dir_pin'),{canInvert:true}).chipName!==owner.get(motor.emitter))throw new Error('Stepper pins must belong to the same MCU');
 const homing:ConfiguredHomingGroup[]=[],layoutHoming:HardwareLayout['homing'][number][]=[];
 for(const rail of config.rails){
  const owned=motors.filter(m=>m.tower===rail.id),separate=owned.filter(m=>m.emitter!==rail.id&&m.emitter!=='e'&&reader.section(m.section).hasOption('endstop_pin'));
  const separated=new Set(separate.map(m=>m.emitter));
  // Idle extrusion is fenced with A. No other moving tower shares its stop.
  const groups=[{section:rail.section,emitters:owned.filter(m=>!separated.has(m.emitter)).map(m=>m.emitter)},...separate.map(m=>({section:m.section,emitters:[m.emitter]}))];
  for(const group of groups){
   const gpio=pins.parse(readHomingPin(reader,group.section).description,{canInvert:true,canPullup:true}).chipName;
   if(!group.emitters.some(id=>id!=='e'&&owner.get(id)===gpio))throw new Error('Delta endstop GPIO requires a motor of its own tower on its MCU');
   homing.push(group);layoutHoming.push({section:group.section,mcus:[...new Set(group.emitters.map(id=>owner.get(id)!))]});
  }
 }
 const probeSection=configuredProbeSection(reader);if(probeSection==='bltouch')throw new Error('Delta BLTouch adapter is not configured');
 const probe=probeSection?[{section:probeSection,emitters:motors.map(m=>m.emitter)}]:undefined;
 if(probe){
  readProbeConfiguration(reader);
  const gpio=pins.parse(readHomingPin(reader,probeSection!).description,{canInvert:true,canPullup:true}).chipName;
  if(!motors.some(m=>m.emitter!=='e'&&owner.get(m.emitter)===gpio))throw new Error('Delta probe GPIO requires a kinematic motor on its MCU');
  layoutHoming.push({section:probeSection!,mcus:[...new Set(owner.values())]});
 }
 const layout:HardwareLayout={steppers:motors.map(m=>({section:m.section,emitter:m.emitter,enableLeadTime:policy.enableLeadTime})),homing:layoutHoming,...planPrinterPeripherals(reader,policy.fanMinimumScheduleTime)};
 const motion:ConfiguredMotionRequest[]=motors.map(m=>({emitter:m.emitter,queueId:m.emitter==='e'?'e':'xyz',mode:m.mode}));
 return {config,layout,motion,probe,homingSettings:Object.freeze({...config.rails[0].homing,endstops:Object.freeze(homing.map(g=>g.section))}),homing:Object.freeze(homing.map(g=>Object.freeze({...g,emitters:Object.freeze([...g.emitters])}))),kinematicIds:Object.freeze(['a','b','c'] as const)};
}
export const compileDeltaHoming=compileHomingGroups;

import {validateNativePrinterSections} from './native-printer-sections.ts';
import {readExtrusionConfiguration} from './extrusion.ts';
import {readArcResolution} from './arcs.ts';
import {readRetraction} from './retraction.ts';
import {readNativeBedMesh} from './native-bed-mesh.ts';
/** Preflight before acquiring physical connections. Unbound components fail. */
export function validateDeltaPrinter(reader:ConfigurationReader){
 validateNativePrinterSections(reader,'delta');
 const config=readDeltaMotionConfiguration(reader);
 readExtrusionConfiguration(reader,config.limits.maxVelocity,config.limits.maxAccel);
 readArcResolution(reader);readRetraction(reader);readNativeBedMesh(reader);readProbeConfiguration(reader);if(configuredProbeSection(reader))readProbeGrid(reader);
}
export function planDeltaPrinter(reader:ConfigurationReader,policy:LinearPrinterPolicy){
 validateDeltaPrinter(reader);const plan=planDeltaHardware(reader,policy);
 return {...plan,delta:{homing:plan.homing,kinematicIds:plan.kinematicIds,...(plan.probe?{probe:plan.probe}:{})},initial:{position:[0,0,0,0],routes:[{id:'xyz'},{id:'e',extrusionAxis:3}],...(reader.hasSection('fan')?{fanSection:'fan'}:{})}};
}
