import {planPrinterPeripherals} from './printer-peripherals.ts';
import {readBedScrews} from './bed-screws.ts';
import {readScrewsTilt} from './screws-tilt.ts';
import {readQuadGantry} from './quad-gantry.ts';
import {readZTilt} from './z-tilt.ts';
import {readHomingPin} from './sensorless.ts';
import {validateNativePrinterSections} from './native-printer-sections.ts';
import {readProbeGrid} from './probe-grid.ts';
import {readProbeConfiguration,configuredProbeSection} from './probe.ts';
import {readNativeBedMesh} from './native-bed-mesh.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readRetraction} from './retraction.ts';
import {readArcResolution} from './arcs.ts';
import {readLinearMotionConfiguration} from './linear-motion.ts';
import type {HardwareLayout} from './hardware.ts';
import type {ConfiguredMotionRequest} from './motion-emitters.ts';
import type {ConfiguredLinearHoming} from './linear-homing.ts';
import type {InitialMotionOptions} from '../runtime/initial-motion.ts';
import {PrinterPins} from '../protocol/pins.ts';
export interface LinearPrinterPolicy {mcus:readonly string[];enableLeadTime:number;fanMinimumScheduleTime:number;}
/** Plan the supported single-extruder linear machine from section names and
 * physical pin ownership. Does not open devices or grant homing authority. */
export function planLinearPrinter(reader:ConfigurationReader,policy:LinearPrinterPolicy){
 if(reader.hasSection('dual_carriage'))throw new Error('Unsupported dual_carriage runtime ownership; configuration geometry alone cannot start hardware');
 readBedScrews(reader);readScrewsTilt(reader);readZTilt(reader);readQuadGantry(reader);const probeSection=configuredProbeSection(reader);if(probeSection)readProbeGrid(reader);readProbeConfiguration(reader);readArcResolution(reader);readRetraction(reader);readNativeBedMesh(reader);
 const {kinematics,probeHoming}=readLinearMotionConfiguration(reader),pins=new PrinterPins<object>();
 if(!policy.mcus.length||policy.mcus.length>16||new Set(policy.mcus).size!==policy.mcus.length||![policy.enableLeadTime,policy.fanMinimumScheduleTime].every(n=>Number.isFinite(n)&&n>0))throw new Error('Invalid linear printer machine policy');
 for(const id of policy.mcus)pins.register(id,{});
 const sections=reader.sections(),axes=['x','y','z'] as const;
 if(sections.some(n=>n.startsWith('stepper_')&&!/^stepper_[xyz](?:[1-9][0-9]*)?$/.test(n))||sections.some(n=>/^extruder[0-9]+$/.test(n)||n.startsWith('extruder_stepper ')))throw new Error('Unsupported linear printer motor topology');
 validateNativePrinterSections(reader);
 const modes:readonly ConfiguredMotionRequest['mode'][]=kinematics.solverModes;
 const motors=axes.flatMap((axis,i)=>sections.filter(n=>n===`stepper_${axis}`||new RegExp(`^stepper_${axis}[1-9][0-9]*$`).test(n)).sort((a,b)=>Number(a.slice(9)||0)-Number(b.slice(9)||0)).map(section=>({section,emitter:section.slice(8),axis:i,mode:modes[i]})));
 motors.push({section:'extruder',emitter:'e',axis:3,mode:'extruder'});
 const owner=new Map(motors.map(m=>[m.emitter,pins.parse(reader.section(m.section).get('step_pin'),{canInvert:true}).chipName]));
 for(const m of motors){const dir=pins.parse(reader.section(m.section).get('dir_pin'),{canInvert:true});if(dir.chipName!==owner.get(m.emitter))throw new Error('Stepper pins must belong to the same MCU');}
 const ids=motors.map(m=>m.emitter),homingLayout:HardwareLayout['homing'][number][]=[],groups=axes.map((axis,index)=>{
  const extra=motors.filter(m=>m.axis===index&&m.emitter!==axis&&reader.section(m.section).hasOption('endstop_pin'));
  if(index===2&&probeHoming&&extra.length)throw new Error('Cannot mix probe Z homing with independent endstops');
  const independent=new Set(extra.map(m=>m.emitter));
  return [{section:index===2&&probeHoming?probeSection!:`stepper_${axis}`,emitters:ids.filter(id=>!independent.has(id))},...extra.map(m=>({section:m.section,emitters:[m.emitter]}))].map(group=>{
   const gpio=pins.parse(readHomingPin(reader,group.section).description,{canInvert:true,canPullup:true}).chipName;
   if(!group.emitters.some(id=>owner.get(id)===gpio&&id!=='e'))throw new Error('Homing GPIO requires an assigned kinematic motor on its MCU');
   const mcus=[...new Set(group.emitters.map(id=>owner.get(id)!))];homingLayout.push({section:group.section,mcus});return group;
  });
 });
 const probe=probeSection?[{section:probeSection,emitters:ids}]:undefined;
 if(probe){
  const gpio=pins.parse(readHomingPin(reader,probeSection!).description,{canInvert:true,canPullup:true}).chipName;
  if(!motors.some(m=>m.axis<3&&owner.get(m.emitter)===gpio))throw new Error('Probe GPIO requires a kinematic motor on its MCU');
  if(!homingLayout.some(h=>h.section===probeSection))homingLayout.push({section:probeSection!,mcus:[...new Set(owner.values())]});
 }
 const layout:HardwareLayout={steppers:motors.map(m=>({section:m.section,emitter:m.emitter,enableLeadTime:policy.enableLeadTime})),homing:homingLayout,...planPrinterPeripherals(reader,policy.fanMinimumScheduleTime)};
 const motion:ConfiguredMotionRequest[]=motors.map(m=>({emitter:m.emitter,queueId:m.axis===3?'e':'xyz',mode:m.mode}));
 const linear:ConfiguredLinearHoming={...(probe?{probe}:{}),kinematicIds:['x','y','z'],homing:groups as unknown as ConfiguredLinearHoming['homing']};
 const initial:InitialMotionOptions={position:[0,0,0,0],routes:[{id:'xyz'},{id:'e',extrusionAxis:3}],...(reader.hasSection('fan')?{fanSection:'fan'}:{})};
 return {layout,motion,linear,initial};
}
