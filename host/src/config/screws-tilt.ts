import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readProbeConfiguration} from './probe.ts';
import {screwThreads,type ScrewThread} from '../motion/screws-tilt.ts';
export interface ScrewsTiltPlan {points:readonly (readonly [number,number])[];names:readonly string[];thread:ScrewThread;horizontalHeight:number;travelSpeed:number;}
export function readScrewsTilt(reader:ConfigurationReader):ScrewsTiltPlan|undefined{
 if(!reader.hasSection('screws_tilt_adjust'))return;
 const probe=readProbeConfiguration(reader);if(!probe)throw new Error('Screw tilt requires a configured probe');
 const s=reader.section('screws_tilt_adjust'),points:[number,number][]=[],names:string[]=[],allowed=new Set(['screw_thread','speed','horizontal_move_z']);
 for(let i=1;i<=99;i++){
  const key='screw'+i;if(!s.hasOption(key))break;
  const point=s.getLists(key,{type:'float',separators:[','],count:[2]}) as number[];
  if(point.length!==2||!point.every(Number.isFinite))throw new Error('Invalid screw coordinates');
  points.push([point[0],point[1]]);const name=s.get(key+'_name',{defaultValue:`screw at ${point[0].toFixed(3)},${point[1].toFixed(3)}`});
  if(!name.trim()||name.length>128||/[\x00-\x1f\x7f]/.test(name))throw new Error('Invalid screw name');names.push(name);allowed.add(key);allowed.add(key+'_name');
 }
 if(points.length<3||Object.keys(s.options()).some(k=>!allowed.has(k)))throw new Error('Expected three to 99 consecutive screw points and supported options');
 const thread=s.get('screw_thread',{defaultValue:'CW-M3'}) as ScrewThread;if(!screwThreads.includes(thread))throw new Error('Invalid screw thread');
 const horizontalHeight=s.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed=s.getFloat('speed',{defaultValue:50,above:0}),z=reader.section('stepper_z');
 if(horizontalHeight<=z.getFloat('position_min',{defaultValue:0})||horizontalHeight>z.getFloat('position_max')||horizontalHeight<probe.offsets[2])throw new Error('Screw travel height exceeds Z or probe range');
 for(const point of points)for(const [i,value] of point.entries()){const axis=reader.section(i?'stepper_y':'stepper_x');if(value<axis.getFloat('position_min',{defaultValue:0})||value>axis.getFloat('position_max'))throw new Error('Screw point exceeds axis range');}
 return Object.freeze({points:Object.freeze(points.map(p=>Object.freeze(p))),names:Object.freeze(names),thread,horizontalHeight,travelSpeed});
}
