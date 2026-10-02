// Input shaper response and smoothing from extras/shaper_calibrate.py.
// Copyright (C) 2020-2024 Dmitry Butyugin. GNU GPLv3.
import {validateShaper} from '../motion/shaper.ts';
import type {Shaper} from '../motion/shaper.ts';
function sum(values: readonly number[]): number {
  let high=0,low=0;
  for(const value of values){const total=high+value;low+=Math.abs(high)>=Math.abs(value)?high-total+value:value-total+high;high=total;}
  return high+low;
}
function nonnegative(value: number): void {if(!Number.isFinite(value)||value<0)throw new RangeError('Expected finite nonnegative value');}
function smoothingFunction(shaper: Shaper, cornerVelocity: number): (accel: number)=>number {
  validateShaper(shaper);nonnegative(cornerVelocity);
  if(!shaper.times.length)return ()=>0;
  const {amplitudes:a,times:t}=shaper,inv=1/sum(a),shift=sum(a.map((v,i)=>v*t[i]))*inv;
  return accel=>{
    const half=accel*.5;let offset90=0,offset180=0;
    for(let i=0;i<t.length;i++) {
      const dt=t[i]-shift;
      if(t[i]>=shift)offset90+=a[i]*(cornerVelocity+half*dt)*dt;
      offset180+=a[i]*half*dt**2;
    }
    const result=Math.max(offset90*inv*Math.sqrt(2),offset180*inv);
    if(!Number.isFinite(result))throw new RangeError('Shaper smoothing overflow');
    return result;
  };
}
export function shaperSmoothing(shaper: Shaper, acceleration=5000, squareCornerVelocity=5): number {
  nonnegative(acceleration);return smoothingFunction(shaper,squareCornerVelocity)(acceleration);
}
/** null means no shaper-imposed acceleration bound (disabled or single identity pulse). */
export function shaperMaxAcceleration(shaper: Shaper, squareCornerVelocity=5): number | null {
  const smoothing=smoothingFunction(shaper,squareCornerVelocity);
  if(shaper.times.length<=1)return null;
  if(smoothing(1e-9)>.12)return 0;
  let left=1,right=1;
  while(smoothing(left)>.12){right=left;left*=.5;}
  if(right===left)while(smoothing(right)<=.12){right*=2;if(!Number.isFinite(right))throw new RangeError('Acceleration bound exceeds numeric range');}
  while(right-left>1e-8) {
    const mid=(left+right)*.5;
    // Stop when floating-point spacing exceeds the original absolute tolerance.
    if(mid===left || mid===right)break;
    if(smoothing(mid)<=.12)left=mid;else right=mid;
  }
  return left;
}
export function shaperResponse(shaper: Shaper, damping: number, frequencies: Float64Array): Float64Array {
  validateShaper(shaper);nonnegative(damping);if(damping>=1)throw new RangeError('Damping must be below one');
  if(frequencies.buffer instanceof SharedArrayBuffer || frequencies.length>1_000_000)throw new RangeError('Invalid frequency buffer');
  const result=new Float64Array(frequencies.length),{amplitudes:a,times:t}=shaper;
  const inv=a.length?1/sum(a):1,df=Math.sqrt(1-damping**2),last=t.at(-1)??0;
  for(let j=0;j<frequencies.length;j++) {
    const frequency=frequencies[j];nonnegative(frequency);
    if(!a.length){result[j]=1;continue;}
    const omega=2*Math.PI*frequency,decay=damping*omega,omegaD=omega*df;
    let sine=0,cosine=0;
    for(let i=0;i<a.length;i++) {
      const weight=a[i]*Math.exp(-decay*(last-t[i])),angle=omegaD*t[i];
      sine+=weight*Math.sin(angle);cosine+=weight*Math.cos(angle);
    }
    const value=Math.sqrt(sine**2+cosine**2)*inv;
    if(!Number.isFinite(value))throw new RangeError('Shaper response overflow');
    result[j]=value;
  }
  return result;
}
export function remainingVibrations(shaper: Shaper,damping:number,frequencies:Float64Array,psd:Float64Array): {vibrations:number;response:Float64Array} {
  if(psd.length!==frequencies.length || !psd.length || psd.buffer instanceof SharedArrayBuffer)throw new RangeError('Invalid PSD dimensions');
  let max=0;for(const p of psd){nonnegative(p);max=Math.max(max,p);}
  const response=shaperResponse(shaper,damping,frequencies),threshold=max/20;
  let remaining=0,total=0;
  for(let i=0;i<psd.length;i++){remaining+=Math.max(response[i]*psd[i]-threshold,0);total+=Math.max(psd[i]-threshold,0);}
  if(!Number.isFinite(remaining) || !Number.isFinite(total))throw new RangeError('PSD accumulation overflow');
  // A silent input has no measurable vibration; avoid the legacy 0/0 result.
  return {vibrations:total?remaining/total:0,response};
}
