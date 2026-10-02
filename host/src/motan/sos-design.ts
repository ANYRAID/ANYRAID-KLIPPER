// Frequency transforms and nearest-pole pairing adapted from SciPy 1.17.1.
// Copyright (c) 2001-2002 Enthought, Inc. 2003, SciPy Developers.
// BSD-3-Clause notice: ../../licenses/scipy-signal.txt.
import type {MotanSOS} from './sos-filter.ts';
import {Complex} from 'complex.js';

export type MotanButterworthKind = 'lowpass' | 'highpass' | 'bandpass';

/** Balance cumulative log responses to avoid concentrating stop-band
 * attenuation in the first sections and amplifying their rounding noise. */
function balanceBandpassSections(rows:number[][]):number[][] {
  const size=512,grid=Array.from({length:size},(_,i)=>{
    const w=Math.PI*(i+.5)/size;
    return [Math.cos(w),Math.sin(w),Math.cos(2*w),Math.sin(2*w),Math.log(2*Math.sin(w))];
  });
  const response=rows.map(row=>Float64Array.from(grid,([c1,s1,c2,s2,logNumerator])=>
    logNumerator-Math.log(Math.hypot(1+row[4]*c1+row[5]*c2,-row[4]*s1-row[5]*s2))));
  if(response.some(row=>row.some(value=>!Number.isFinite(value))))throw new Error('Motan Butterworth response cannot be represented stably');
  const total=Float64Array.from({length:size},(_,i)=>response.reduce((sum,row)=>sum+row[i],0));
  const current=new Float64Array(size),remaining=rows.map((_,i)=>i),result:number[][]=[];
  for(let step=0;step<rows.length;step++){
    const target=Float64Array.from(total,value=>value*(step+1)/rows.length);
    let best=-1,score=Infinity;
    for(let j=0;j<remaining.length;j++){
      const row=response[remaining[j]];let error=0;
      for(let i=0;i<size;i++)error=Math.max(error,Math.abs(current[i]+row[i]-target[i]));
      if(error<score){score=error;best=j;}
    }
    const chosen=remaining.splice(best,1)[0];result.push(rows[chosen]);
    for(let i=0;i<size;i++)current[i]+=response[chosen][i];
  }
  return result;
}

/** Butterworth prototype, analog frequency transform, then bilinear mapping.
 * All zeros are real, so section pairing needs no general polynomial solver. */
export function motanButterworth(order:number,cutoff:number|readonly number[],
                                 kind:MotanButterworthKind,sampleRate:number):MotanSOS {
  if(!Number.isSafeInteger(order)||order<0||order>64||!Number.isFinite(sampleRate)||sampleRate<=0
     ||!['lowpass','highpass','bandpass'].includes(kind))throw new Error('Invalid Motan Butterworth parameters');
  const frequencies=typeof cutoff==='number'?[cutoff]:cutoff;
  if(!Array.isArray(frequencies)||frequencies.length!==(kind==='bandpass'?2:1)
     ||frequencies.some(f=>typeof f!=='number'||!Number.isFinite(f)||!(f>0&&f<sampleRate/2))
     ||frequencies.length===2&&frequencies[0]>=frequencies[1])throw new Error('Invalid Motan Butterworth cutoff');
  if(!order)return Object.freeze([Object.freeze([1,0,0,1,0,0])]);
  const warped=frequencies.map(f=>4*Math.tan(Math.PI*(f/(sampleRate/2))/2));
  let poles:Complex[]=[],zeros:number[]=[],gain=1;
  for(let m=-order+1;m<order;m+=2){const phase=Math.PI*m/(2*order);poles.push(new Complex(-Math.cos(phase),-Math.sin(phase)));}
  const product=(values:Complex[])=>values.reduce((a,b)=>a.mul(b),new Complex(1));
  if(kind==='lowpass'){poles=poles.map(p=>p.mul(warped[0]));gain=warped[0]**order;}
  else if(kind==='highpass'){
    gain=new Complex(1).div(product(poles.map(p=>p.neg()))).re;
    poles=poles.map(p=>new Complex(warped[0]).div(p));zeros=Array(order).fill(0);
  }else{
    const bandwidth=warped[1]-warped[0],center=Math.sqrt(warped[0]*warped[1]);
    const scaled=poles.map(p=>p.mul(bandwidth).div(2));
    const roots=scaled.map(p=>p.mul(p).sub(center**2).sqrt());
    poles=[...scaled.map((p,i)=>p.add(roots[i])),...scaled.map((p,i)=>p.sub(roots[i]))];
    zeros=Array(order).fill(0);gain=bandwidth**order;
  }
  const degree=poles.length-zeros.length;
  gain*=new Complex(zeros.reduce((a,z)=>a*(4-z),1)).div(product(poles.map(p=>new Complex(4).sub(p)))).re;
  poles=poles.map(p=>new Complex(4).add(p).div(new Complex(4).sub(p)));
  zeros=zeros.map(z=>(4+z)/(4-z)).concat(Array(degree).fill(-1));
  if(!Number.isFinite(gain)||gain<=0||poles.some(p=>!Number.isFinite(p.re)||!Number.isFinite(p.im)||!(p.abs()<1)))
    throw new Error('Motan Butterworth poles or gain cannot be represented stably');
  const sections=Math.ceil(poles.length/2);
  if(poles.length%2){poles.push(new Complex(0));zeros.push(0);}
  // Transform symmetry yields conjugate pairs; retain positive members and
  // sort them before real poles, matching nearest-pair SOS construction.
  const real:Complex[]=[],pairs:Complex[]=[];
  for(const p of poles){if(Math.abs(p.im)<=100*Number.EPSILON*p.abs())real.push(new Complex(p.re));else if(p.im>0)pairs.push(p);}
  pairs.sort((a,b)=>a.re-b.re||a.im-b.im);real.sort((a,b)=>a.re-b.re);
  poles=[...pairs,...real];zeros.sort((a,b)=>a-b);
  const worst=(realOnly=false)=>{
    let index=-1,distance=Infinity;
    for(let i=0;i<poles.length;i++){if(realOnly&&poles[i].im!==0)continue;const d=Math.abs(1-poles[i].abs());if(d<distance){index=i;distance=d;}}
    if(index<0)throw new Error('Invalid Motan Butterworth pole pairing');return poles.splice(index,1)[0];
  };
  const nearest=(pole:Complex)=>{
    let index=-1,distance=Infinity;
    for(let i=0;i<zeros.length;i++){const d=pole.sub(zeros[i]).abs();if(d<distance){index=i;distance=d;}}
    if(index<0)throw new Error('Invalid Motan Butterworth zero pairing');return zeros.splice(index,1)[0];
  };
  let result:number[][]=Array(sections);
  for(let i=sections-1;i>=0;i--){
    const p1=worst(),single=p1.im===0&&!poles.some(p=>p.im===0);
    const p2=single?new Complex(0):p1.im===0?worst(true):p1.conjugate();
    const z1=nearest(p1),z2=single?0:nearest(p1);
    const a1=-p1.add(p2).re,a2=p1.mul(p2).re;
    if(!(Math.abs(a2)<1)||!(1+a1+a2>0)||!(1-a1+a2>0))throw new Error('Motan Butterworth section cannot be represented stably');
    result[i]=[1,-(z1+z2),z1*z2,1,a1,a2];
  }
  if(poles.length||zeros.length)throw new Error('Incomplete Motan Butterworth pairing');
  // A bandpass has N zeros at +1 and N at -1. Put one of each in every
  // section, avoiding cascades of huge DC gain followed by DC cancellation.
  if(kind==='bandpass')for(const row of result){row[1]=0;row[2]=-1;}
  if(kind==='bandpass'&&order>16)result=balanceBandpassSections(result);
  for(let i=0;i<3;i++)result[0][i]*=gain;
  return Object.freeze(result.map(row=>Object.freeze(row)));
}

/** Real second-order notch, with bandwidth strictly below Nyquist.
 * Keep the transfer polynomial directly instead of a root round-trip. */
export function motanNotch(frequency: number, quality: number, sampleRate: number): MotanSOS {
  if (![frequency, quality, sampleRate].every(Number.isFinite)
      || frequency <= 0 || quality <= 0 || sampleRate <= 0)
    throw new Error('Invalid Motan notch parameters');
  const normalized = 2 * frequency / sampleRate;
  const bandwidth = normalized / quality;
  if (!(normalized > 0 && normalized < 1 && bandwidth > 0 && bandwidth < 1))
    throw new Error('Motan notch frequency and bandwidth must be below Nyquist');
  const gain = 1 / (1 + Math.tan((bandwidth * Math.PI) / 2));
  const cosine = Math.cos(normalized * Math.PI);
  const row = [gain, gain * (-2 * cosine), gain, 1, -2 * gain * cosine, 2 * gain - 1];
  // Resolve rounded-to-unit poles explicitly; no silently singular filter.
  if (row.some(value => !Number.isFinite(value)) || !(Math.abs(row[5]) < 1)
      || !(1 + row[4] + row[5] > 0) || !(1 - row[4] + row[5] > 0))
    throw new Error('Motan notch poles cannot be represented stably');
  return Object.freeze([Object.freeze(row)]);
}
