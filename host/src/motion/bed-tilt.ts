// Bed tilt compensation from klippy/extras/bed_tilt.py. GPL-3.0-or-later.
import {gaussianSolve} from '../math/mathutil.ts';
export interface BedTiltAdjust {x:number;y:number;z:number;}
/** Preserve the original binary64 operation order; never round live coefficients. */
export class BedTilt {
 readonly adjust:Readonly<BedTiltAdjust>;
 constructor(adjust:BedTiltAdjust){if(![adjust.x,adjust.y,adjust.z].every(Number.isFinite))throw new RangeError('Invalid bed tilt');this.adjust=Object.freeze({...adjust});Object.freeze(this);}
 #transform(position:readonly number[],inverse:boolean):number[]{
  if(position.length<4||position.length>67||!position.every(Number.isFinite))throw new RangeError('Invalid bed tilt position');
  const p=[...position],a=this.adjust,correction=p[0]*a.x+p[1]*a.y+a.z;
  p[2]=inverse?p[2]-correction:p[2]+correction;
  if(!Number.isFinite(p[2]))throw new RangeError('Bed tilt coordinate overflow');return p;
 }
 apply(position:readonly number[]){return this.#transform(position,false);}
 unapply(position:readonly number[]){return this.#transform(position,true);}
}
export function fitBedTilt(points:readonly (readonly number[])[]):BedTilt{
 if(points.length<3||points.length>128||points.some(p=>p.length!==3||!p.every(Number.isFinite)))throw new RangeError('Invalid bed tilt samples');
 // Python 3.12 sum uses compensated accumulation. Keep it for the normal
 // equations without changing the shared solver used by existing calibrations.
 const dot=(a:readonly number[],b:readonly number[])=>{let high=0,low=0;for(let i=0;i<a.length;i++){const value=a[i]*b[i],next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}return high+low;};
 const columns=[points.map(()=>1),points.map(p=>p[0]),points.map(p=>p[1])],height=points.map(p=>p[2]);
 const result=gaussianSolve(columns.map(a=>columns.map(b=>dot(a,b))),columns.map(a=>[dot(a,height)]));
 if(!result)throw new RangeError('Unable to calculate bed tilt');
 return new BedTilt({x:result[1][0],y:result[2][0],z:result[0][0]});
}
