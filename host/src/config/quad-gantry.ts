import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {BedTiltProbePlan} from './bed-tilt.ts';
import {readProbeConfiguration} from './probe.ts';
import {planQuadGantry} from '../motion/quad-gantry.ts';
export interface QuadGantryCalibrationPlan extends BedTiltProbePlan {motorIds:readonly string[];corners:readonly (readonly [number,number])[];maximumTravel:number;retries:number;retryTolerance:number;}
/** Configured mechanical calibration; no client-supplied motor or move targets. */
export function readQuadGantry(reader:ConfigurationReader):QuadGantryCalibrationPlan|undefined{
 if(!reader.hasSection('quad_gantry_level'))return undefined;
 const probe=readProbeConfiguration(reader);if(!probe)throw new Error('Quad gantry requires a configured probe');
 if(reader.section('printer').get('kinematics')==='corexz'||reader.hasSection('bed_tilt')||reader.hasSection('z_tilt'))throw new Error('Quad gantry requires independent Z motors without bed_tilt compensation');
 const section=reader.section('quad_gantry_level'),allowed=new Set(['gantry_corners','points','speed','horizontal_move_z','retries','retry_tolerance','max_adjust']);
 if(Object.keys(section.options()).some(k=>!allowed.has(k)))throw new Error('Unsupported Quad gantry option');
 const ids=reader.sections().filter(n=>/^stepper_z(?:[1-9][0-9]*)?$/.test(n)).sort((a,b)=>Number(a.slice(9)||0)-Number(b.slice(9)||0)).map(n=>n.slice(8));
 const corners=section.getLists('gantry_corners',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][];
 if(ids.length!==4||corners.length!==2)throw new Error('Quad gantry requires four motors and two opposite corners');
 const points=section.getLists('points',{type:'float',separators:['\n',','],count:[null,2]}) as [number,number][];
 const plan={points:Object.freeze(points.map(p=>Object.freeze(p))),motorIds:Object.freeze(ids),corners:Object.freeze(corners.map(p=>Object.freeze(p))),horizontalHeight:section.getFloat('horizontal_move_z',{defaultValue:5}),travelSpeed:section.getFloat('speed',{defaultValue:50,above:0}),maximumTravel:section.getFloat('max_adjust',{defaultValue:4,above:0}),retries:section.getInt('retries',{defaultValue:0,minval:0,maxval:30}),retryTolerance:section.getFloat('retry_tolerance',{defaultValue:0,minval:0,maxval:1})};
 const z=reader.section('stepper_z'),minimum=z.getFloat('position_min',{defaultValue:0}),maximum=z.getFloat('position_max');
 if(plan.horizontalHeight<=minimum||plan.horizontalHeight>maximum||plan.horizontalHeight<probe.offsets[2])throw new Error('Quad gantry horizontal height exceeds probe or Z range');
 for(const [x,y] of points)for(const [i,v] of [x,y].entries()){const axis=reader.section(i?'stepper_y':'stepper_x');if(v<axis.getFloat('position_min',{defaultValue:0})||v>axis.getFloat('position_max'))throw new Error('Quad gantry probe point out of range');}
 planQuadGantry(points.map(([x,y])=>[x+probe.offsets[0],y+probe.offsets[1],0]),plan.corners,plan.motorIds,plan.horizontalHeight,plan.maximumTravel);
 return Object.freeze(plan);
}
