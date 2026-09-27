import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {validateBedScrewsPlan,type BedScrewPoint,type BedScrewsPlan} from '../homing/bed-screws.ts';
export function readBedScrews(reader:ConfigurationReader):BedScrewsPlan|undefined{
 if(!reader.hasSection('bed_screws'))return;
 const s=reader.section('bed_screws'),coarse:BedScrewPoint[]=[],fine:BedScrewPoint[]=[],allowed=new Set(['speed','probe_speed','horizontal_move_z','probe_height']);
 for(let i=1;i<=99;i++){
  const key='screw'+i;if(!s.hasOption(key))break;
  const point=s.getLists(key,{type:'float',separators:[','],count:[2]}) as [number,number],name=s.get(key+'_name',{defaultValue:`screw at ${point[0].toFixed(3)},${point[1].toFixed(3)}`});coarse.push({position:point,name});
  if(s.hasOption(key+'_fine_adjust'))fine.push({position:s.getLists(key+'_fine_adjust',{type:'float',separators:[','],count:[2]}) as [number,number],name});
  for(const suffix of ['','_name','_fine_adjust'])allowed.add(key+suffix);
 }
 if(Object.keys(s.options()).some(k=>!allowed.has(k)))throw new Error('Unknown or nonconsecutive bed screw option');
 const plan={coarse,fine,horizontalHeight:s.getFloat('horizontal_move_z',{defaultValue:5}),contactHeight:s.getFloat('probe_height',{defaultValue:0}),travelSpeed:s.getFloat('speed',{defaultValue:50,above:0}),liftSpeed:s.getFloat('probe_speed',{defaultValue:5,above:0})};validateBedScrewsPlan(plan);
 const axes=['stepper_x','stepper_y','stepper_z'].map(name=>reader.section(name));
 for(const point of [...coarse,...fine])for(const [i,value] of point.position.entries())if(value<axes[i].getFloat('position_min',{defaultValue:0})||value>axes[i].getFloat('position_max'))throw new Error('Bed screw coordinate exceeds axis range');
 if(plan.contactHeight<axes[2].getFloat('position_min',{defaultValue:0})||plan.horizontalHeight>axes[2].getFloat('position_max'))throw new Error('Bed screw height exceeds Z range');
 return plan;
}
