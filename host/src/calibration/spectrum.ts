// Welch PSD port of klippy/extras/shaper_calibrate.py (GPL-3.0-or-later).
// Original Copyright (C) 2020-2024 Dmitry Butyugin.
import FFT from 'fft.js';
export interface Spectrum {
  name: string;
  frequencies: Float64Array;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  sum: Float64Array;
  sampleRate: number;
  fftSize: number;
  normalized?: boolean;
}
// I0 power series is convergent and positive for the fixed Kaiser beta=6.
function besselI0(x: number): number {
  let sum=1, term=1;
  for(let k=1;k<100;k++) {
    term *= x*x/(4*k*k);
    sum += term;
    if(term <= Number.EPSILON*sum) return sum;
  }
  throw new Error('Kaiser window did not converge');
}
export function kaiserWindow(n: number): Float64Array {
  if(!Number.isInteger(n) || n<2 || n>65536) throw new RangeError('Invalid window length');
  const denom=besselI0(6);
  const window=new Float64Array(n);
  for(let i=0;i<n;i++) window[i]=besselI0(6*Math.sqrt(Math.max(0,1-(2*i/(n-1)-1)**2)))/denom;
  return window;
}
// At most 16 power-of-two plans per isolate. Scratch arrays never escape.
const plans=new Map<number,{window:Float64Array; fft:FFT; input:Float64Array; output:Float64Array; energy:number}>();
function getPlan(n:number) {
  const cached=plans.get(n);
  if(cached) return cached;
  const window=kaiserWindow(n);
  let energy=0;
  for(let i=0;i<n;i++) energy+=window[i]*window[i];
  const plan={window,energy,fft:new FFT(n),input:new Float64Array(n),output:new Float64Array(2*n)};
  plans.set(n,plan);
  return plan;
}
export function welchPsd(samples: Float64Array, sampleRate: number, nfft: number): {frequencies:Float64Array; psd:Float64Array} {
  if(!Number.isFinite(sampleRate) || sampleRate<=0 || !Number.isInteger(nfft) || nfft<2 || nfft>65536 || (nfft & (nfft-1))!==0)
    throw new RangeError('Invalid PSD sample rate or FFT size');
  if(samples.length<nfft || samples.length>4_000_000) throw new RangeError('Invalid PSD samples');
  for(let i=0;i<samples.length;i++) if(!Number.isFinite(samples[i])) throw new RangeError('Invalid PSD samples');
  const {window,fft,input,output,energy}=getPlan(nfft);
  const psd=new Float64Array(nfft/2+1);
  const overlap=nfft/2, count=Math.floor((samples.length-overlap)/overlap);
  const factor=1/energy/sampleRate/count;
  for(let index=0;index<count;index++) {
    const offset=index*overlap;
    let mean=0;
    for(let i=0;i<nfft;i++) mean+=samples[offset+i];
    mean/=nfft;
    for(let i=0;i<nfft;i++) input[i]=window[i]*(samples[offset+i]-mean);
    fft.realTransform(output,input);
    for(let i=0;i<psd.length;i++) psd[i]+=(output[2*i]**2+output[2*i+1]**2)*factor*(i===0 || i===nfft/2 ? 1 : 2);
  }
  if(!psd.every(Number.isFinite)) throw new RangeError('PSD overflow');
  const frequencies=new Float64Array(psd.length);
  for(let i=0;i<psd.length;i++) frequencies[i]=i*sampleRate/nfft;
  return {frequencies,psd};
}
// Interleaved [time,x,y,z] in seconds and acceleration units of the source sensor.
export function calculateSpectrum(name: string, raw: Float64Array): Spectrum | null {
  if(raw.length%4!==0 || raw.length>16_000_000) throw new RangeError('Invalid accelerometer samples');
  for(let i=0;i<raw.length;i++) if(!Number.isFinite(raw[i])) throw new RangeError('Invalid accelerometer samples');
  const n=raw.length/4;
  if(n<2) return null;
  for(let i=1;i<n;i++) if(raw[i*4]<=raw[(i-1)*4]) throw new RangeError('Sample timestamps must increase');
  // Preserve upstream N/T (not (N-1)/T) for compatibility of fitted frequencies.
  const sampleRate=n/(raw[(n-1)*4]-raw[0]);
  const fftSize=2**Math.ceil(Math.log2(Math.max(1,Math.floor(sampleRate*.5))));
  if(!Number.isFinite(sampleRate) || fftSize<2 || fftSize>65536) throw new RangeError('Unsupported sampling frequency');
  if(n<=fftSize) return null;
  const axes=[];
  const channel=new Float64Array(n);
  for(let axis=1;axis<=3;axis++) {
    for(let i=0;i<n;i++) channel[i]=raw[i*4+axis];
    axes.push(welchPsd(channel,sampleRate,fftSize));
  }
  const [x,y,z]=axes.map(a => a.psd);
  const sum=Float64Array.from(x,(v,i) => v+y[i]+z[i]);
  if(!sum.every(Number.isFinite)) throw new RangeError('PSD sum overflow');
  return {name,frequencies:axes[0].frequencies,x,y,z,sum,sampleRate,fftSize};
}
export function normalizeSpectrum(data: Spectrum): Spectrum {
  if(data.normalized) return data;
  const normalize=(values:Float64Array) => Float64Array.from(values,(v,i) => {
    const f=data.frequencies[i];
    return v/(f+.1)*(f<10 ? Math.exp(-((10/(f+.1))**2)+1) : 1);
  });
  return {...data,normalized:true,frequencies:data.frequencies.slice(),x:normalize(data.x),y:normalize(data.y),z:normalize(data.z),sum:normalize(data.sum)};
}
