import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {ExtrusionGuard} from '../motion/extrusion.ts';
/** Shared extruder policy with the original Python default-ratio arithmetic. */
export function readExtrusionConfiguration(reader:ConfigurationReader,maxVelocity:number,maxAccel:number,sectionName='extruder'){
 const extruder=reader.section(sectionName),nozzleDiameter=extruder.getFloat('nozzle_diameter',{above:0}),filamentDiameter=extruder.getFloat('filament_diameter',{minval:nozzleDiameter}),defaultCrossSection=4*nozzleDiameter**2,defaultRatio=defaultCrossSection/(Math.PI*(filamentDiameter*.5)**2);
 // Extrude-only defaults use the DEFAULT cross section, even when the configured
 // maximum cross section is overridden. Preserve Python's numerical contract.
 const extrusion=new ExtrusionGuard({nozzleDiameter,filamentDiameter,maxCrossSection:extruder.getFloat('max_extrude_cross_section',{defaultValue:defaultCrossSection,above:0}),maxVelocity:extruder.getFloat('max_extrude_only_velocity',{defaultValue:maxVelocity*defaultRatio,above:0}),maxAccel:extruder.getFloat('max_extrude_only_accel',{defaultValue:maxAccel*defaultRatio,above:0}),maxDistance:extruder.getFloat('max_extrude_only_distance',{defaultValue:50,minval:0}),instantCornerVelocity:extruder.getFloat('instantaneous_corner_velocity',{defaultValue:1,minval:0})});
 return extrusion;
}

/** Canonical filament axis order, independent of configuration section order. */
export function extrusionSections(reader:ConfigurationReader):readonly string[]{
 const sections=reader.sections().filter(s=>/^extruder[0-9]*$/.test(s));
 if(!sections.includes('extruder')||sections.length>13||sections.some(s=>s!=='extruder'&&!/^extruder[1-9][0-9]*$/.test(s)))throw new Error('Invalid extruder topology');
 const sorted=sections.sort((a,b)=>Number(a.slice(8)||0)-Number(b.slice(8)||0));
 if(sorted.some((s,i)=>s!==(i?'extruder'+i:'extruder')))throw new Error('Extruder topology must use contiguous tool numbers');
 return Object.freeze(sorted);
}
