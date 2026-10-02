import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {BedTilt,fitBedTilt} from '../motion/bed-tilt.ts';
export interface BedTiltProbePlan {points:readonly (readonly [number,number])[];horizontalHeight:number;travelSpeed:number;}
export function readBedTilt(reader:ConfigurationReader){
 if(!reader.hasSection('bed_tilt'))return undefined;
 if(reader.hasSection('bed_mesh'))throw new Error('Bed tilt and bed mesh cannot own the same move transform');
 const s=reader.section('bed_tilt'),tilt=new BedTilt({x:s.getFloat('x_adjust',{defaultValue:0}),y:s.getFloat('y_adjust',{defaultValue:0}),z:s.getFloat('z_adjust',{defaultValue:0})});
 let calibration:BedTiltProbePlan|undefined;
 if(s.hasOption('points')){
  const points=s.getLists('points',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][];
  // Reject degenerate geometry before any automatic travel, using the same solver.
  fitBedTilt(points.map(p=>[...p,0]));
  calibration=Object.freeze({points:Object.freeze(points.map(p=>Object.freeze(p))),horizontalHeight:s.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:s.getFloat('speed',{defaultValue:50,above:0})});
 }
 return {tilt,calibration};
}
