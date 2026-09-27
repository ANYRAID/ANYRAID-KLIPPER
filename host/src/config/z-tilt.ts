import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {BedTiltProbePlan} from './bed-tilt.ts';
import {readProbeConfiguration} from './probe.ts';
import {planZTilt,type ZTiltMotor} from '../motion/z-tilt.ts';
export interface ZTiltCalibrationPlan extends BedTiltProbePlan {motors:readonly ZTiltMotor[];maximumTravel:number;retries:number;retryTolerance:number;}
/** Configured mechanical calibration; no client-supplied motor or move targets. */
export function readZTilt(reader:ConfigurationReader):ZTiltCalibrationPlan|undefined{
 if(!reader.hasSection('z_tilt'))return undefined;
 const probe=readProbeConfiguration(reader);if(!probe)throw new Error('Z tilt requires a configured probe');
 if(reader.section('printer').get('kinematics')==='corexz'||reader.hasSection('bed_tilt'))throw new Error('Z tilt requires independent Z motors without bed_tilt compensation');
 const section=reader.section('z_tilt'),allowed=new Set(['z_positions','points','speed','horizontal_move_z','retries','retry_tolerance','max_adjust']);
 if(Object.keys(section.options()).some(k=>!allowed.has(k)))throw new Error('Unsupported Z tilt option');
 const ids=reader.sections().filter(n=>/^stepper_z(?:[1-9][0-9]*)?$/.test(n)).sort((a,b)=>Number(a.slice(9)||0)-Number(b.slice(9)||0)).map(n=>n.slice(8));
 const pivots=section.getLists('z_positions',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][];
 if(pivots.length!==ids.length)throw new Error('Z tilt pivots must cover every Z motor');
 const points=section.getLists('points',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][];
 const plan={points:Object.freeze(points.map(p=>Object.freeze(p))),motors:Object.freeze(pivots.map(([x,y],i)=>Object.freeze({id:ids[i],x,y}))),horizontalHeight:section.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:section.getFloat('speed',{defaultValue:50,above:0}),maximumTravel:section.getFloat('max_adjust',{defaultValue:5,above:0}),retries:section.getInt('retries',{defaultValue:0,minval:0,maxval:30}),retryTolerance:section.getFloat('retry_tolerance',{defaultValue:0,minval:0,maxval:1})};
 const z=reader.section('stepper_z'),minimum=z.getFloat('position_min',{defaultValue:0}),maximum=z.getFloat('position_max');
 if(plan.horizontalHeight<=minimum||plan.horizontalHeight>maximum||plan.horizontalHeight<probe.offsets[2])throw new Error('Z tilt horizontal height exceeds probe or Z range');
 for(const [x,y] of points)for(const [i,v] of [x,y].entries()){const axis=reader.section(i?'stepper_y':'stepper_x');if(v<axis.getFloat('position_min',{defaultValue:0})||v>axis.getFloat('position_max'))throw new Error('Z tilt probe point out of range');}
 planZTilt(points.map(([x,y])=>[x+probe.offsets[0],y+probe.offsets[1],0]),plan.motors,plan.horizontalHeight,plan.maximumTravel);
 return Object.freeze(plan);
}
