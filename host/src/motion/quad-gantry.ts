// Four-motor gantry geometry from klippy/extras/quad_gantry_level.py.
// Copyright (C) 2018 Maks Zolin. GPL-3.0-or-later.
import {planZAdjustments} from './z-adjustments.ts';
/** Points: front-left, rear-left, rear-right, front-right. Corners are
 * diagonally opposite actuator coordinates. Inputs are physical bed XYZ. */
export function planQuadGantry(samples:readonly (readonly number[])[],corners:readonly (readonly number[])[],motorIds:readonly string[],currentZ:number,maximumTravel:number){
 if(samples.length!==4||samples.some(p=>p.length!==3||!p.every(Number.isFinite))||corners.length!==2||corners.some(p=>p.length!==2||!p.every(Number.isFinite))||motorIds.length!==4)throw new RangeError('Invalid quad gantry geometry');
 const [p0,p1,p2,p3]=samples,[low,high]=corners;
 if(low[0]>=high[0]||low[1]>=high[1]||p0[1]!==p3[1]||p1[1]!==p2[1]||p0[1]>=p1[1]||p0[0]>=p3[0]||p1[0]>=p2[0])throw new RangeError('Quad gantry requires ordered nondegenerate probe rows and corners');
 // Anchor interpolation at the sampled coordinates. Avoid slope*largeOrigin
 // cancellation; common probe height cancels before extrapolation and averaging.
 const reference=p0[2],values=samples.map(p=>p[2]-reference);
 const interpolate=(a:number,b:number,x0:number,x1:number,x:number)=>a+(b-a)*((x-x0)/(x1-x0));
 const front=(x:number)=>interpolate(values[0],values[3],p0[0],p3[0],x),rear=(x:number)=>interpolate(values[1],values[2],p1[0],p2[0],x);
 const at=(x:number,y:number)=>interpolate(front(x),rear(x),p0[1],p1[1],y);
 const heights=[at(low[0],low[1]),at(low[0],high[1]),at(high[0],high[1]),at(high[0],low[1])];
 const mean=heights.reduce((n,v)=>n+v/4,0),adjustments=heights.map((v,i)=>({id:motorIds[i],adjustment:v-mean}));
 const plan=planZAdjustments(adjustments,currentZ,maximumTravel);
 return Object.freeze({...plan,relativeHeights:Object.freeze(heights),measuredRange:Math.max(...samples.map(p=>p[2]))-Math.min(...samples.map(p=>p[2]))});
}
