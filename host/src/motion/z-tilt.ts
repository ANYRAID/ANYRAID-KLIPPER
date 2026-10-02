import {planZAdjustments} from './z-adjustments.ts';
// Mechanical Z adjustment from klippy/extras/z_tilt.py; GPL-3.0-or-later.
import {gaussianSolve} from '../math/mathutil.ts';
export interface ZTiltMotor {id:string;x:number;y:number;}
/** This is a pure plan, never permission to move motors. Runtime integration
 * must fence motion, own each motor, reattach on failure and invalidate homing. */
export function planZTilt(samples:readonly (readonly number[])[],motors:readonly ZTiltMotor[],currentZ:number,maximumTravel:number){
 if(samples.length<2||samples.length>128||samples.some(p=>p.length!==3||!p.every(Number.isFinite))||motors.length<2||motors.length>16||motors.some(m=>!m.id||!Number.isFinite(m.x)||!Number.isFinite(m.y))||new Set(motors.map(m=>m.id)).size!==motors.length||!Number.isFinite(currentZ)||!Number.isFinite(maximumTravel)||maximumTravel<=0)throw new RangeError('Invalid Z tilt plan inputs');
 if(!samples.some(p=>p[0]!==samples[0][0]||p[1]!==samples[0][1]))throw new RangeError('Z tilt samples have no spatial separation');
 if(new Set(motors.map(m=>JSON.stringify([m.x,m.y]))).size!==motors.length)throw new RangeError('Z tilt motor pivots must be distinct');
 // Match Python 3.12 compensated sums in the existing normal-equation solver.
 const dot=(a:readonly number[],b:readonly number[])=>{let high=0,low=0;for(let i=0;i<a.length;i++){const value=a[i]*b[i],next=high+value;low+=Math.abs(high)>=Math.abs(value)?(high-next)+value:(value-next)+high;high=next;}return high+low;};
 const ones=samples.map(()=>1),mx=dot(samples.map(p=>p[0]),ones)/samples.length,my=dot(samples.map(p=>p[1]),ones)/samples.length,mz=dot(samples.map(p=>p[2]),ones)/samples.length;
 const dx=samples.map(p=>p[0]-mx),dy=samples.map(p=>p[1]-my),dz=samples.map(p=>p[2]-mz),xx=dot(dx,dx),xy=dot(dx,dy),yy=dot(dy,dy),xz=dot(dx,dz),yz=dot(dy,dz),trace=xx+yy,det=xx*yy-xy*xy;
 if(![mx,my,mz,xx,xy,yy,xz,yz,trace,det].every(Number.isFinite)||trace<=0)throw new RangeError('Z tilt geometry overflow');
 let x:number,y:number;
 if(det>1e-12*trace*trace){const solved=gaussianSolve([[xx,xy],[xy,yy]],[[xz],[yz]]);if(!solved)throw new RangeError('Z tilt geometry is ill-conditioned');x=solved[0][0];y=solved[1][0];}
 else{
  // A collinear probe set measures slope in only one direction. Use its
  // centered rank-one pseudoinverse; reject unobservable relative motor axes.
  const index=dx.reduce((best,v,i)=>v*v+dy[i]*dy[i]>dx[best]*dx[best]+dy[best]*dy[best]?i:best,0),vx=dx[index],vy=dy[index],length=Math.hypot(vx,vy);
  const parallel=(px:number,py:number)=>Math.abs(px*vy-py*vx)<=1e-12*length*Math.max(1,Math.hypot(px,py));
  if(!dx.every((v,i)=>parallel(v,dy[i]))||!motors.every(m=>parallel(m.x-motors[0].x,m.y-motors[0].y)))throw new RangeError('Z tilt relative motor slope is not observable');
  x=(xx*xz+xy*yz)/(trace*trace);y=(xy*xz+yy*yz)/(trace*trace);
 }
 const z=mz-mx*x-my*y,adjustments=motors.map(m=>({id:m.id,adjustment:m.x*x+m.y*y+z}));
 if(![x,y,z,...adjustments.map(m=>m.adjustment)].every(Number.isFinite))throw new RangeError('Z tilt fit overflow');
 return Object.freeze({...planZAdjustments(adjustments,currentZ,maximumTravel),fit:Object.freeze({x,y,z})});
}
