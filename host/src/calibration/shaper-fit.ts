// Automatic input shaper fitting; derived from extras/shaper_calibrate.py.
// Copyright (C) 2020-2024 Dmitry Butyugin. GNU GPLv3.
import {inputShaper,parseShaperName,shaperConfigs} from '../motion/shaper.ts';
import {remainingVibrations,shaperSmoothing,shaperMaxAcceleration} from './shaper.ts';
export interface ShaperDataset {frequencies:Float64Array; psd:Float64Array}
export interface FitOptions {
  shapers?:string[]; frequencies?:number[]; range?:{start?:number;end?:number;step?:number};
  damping?:number; testDamping?:number[]; squareCornerVelocity?:number;
  maxSmoothing?:number; maxVibrations?:number; maxFrequency?:number;
}
export interface FitResult {name:string;frequency:number;frequencies:Float64Array;values:Float64Array;vibrations:number;smoothing:number;score:number;maxAcceleration:number}
export interface ShaperFit {best:FitResult;shapers:FitResult[];candidates:FitResult[][]}
function nonnegative(n:number):boolean{return Number.isFinite(n)&&n>=0;}
function grid(start:number,end:number,step:number):number[] {
  if(!nonnegative(start)||!Number.isFinite(end)||end<=start||!Number.isFinite(step)||step<=0)throw new RangeError('Invalid frequency range');
  const count=Math.ceil((end-start)/step);if(count>10000)throw new RangeError('Frequency grid too large');
  // Match numpy.arange's effective step after rounding the first addition.
  const delta=(start+step)-start;if(!delta)throw new RangeError('Frequency step below numeric resolution');
  return Array.from({length:count},(_,i)=>start+i*delta);
}
function validateDataset(data:ShaperDataset):void {
  const {frequencies:f,psd}=data;
  if(!(f instanceof Float64Array)||!(psd instanceof Float64Array)||!f.length||f.length!==psd.length||f.length>1_000_000
      ||f.buffer instanceof SharedArrayBuffer||psd.buffer instanceof SharedArrayBuffer)throw new RangeError('Invalid calibration dataset');
  for(let i=0;i<f.length;i++)if(!nonnegative(f[i])||!nonnegative(psd[i])||(i&&f[i]<=f[i-1]))throw new RangeError('Frequencies must increase and PSD must be finite/nonnegative');
}
/** Returns owned normalized data; does not mutate acquisition samples. Call once. */
export function normalizeShaperDataset(data:ShaperDataset):ShaperDataset {
  validateDataset(data);return {frequencies:data.frequencies.slice(),psd:Float64Array.from(data.psd,(p,i)=>{
    const f=data.frequencies[i],v=p/(f+.1),result=f<10?v*Math.exp(-((10/(f+.1))**2)+1):v;
    if(!Number.isFinite(result))throw new RangeError('PSD normalization overflow');return result;
  })};
}
function interpolate(target:Float64Array,x:Float64Array,y:Float64Array,output:Float64Array):void {
  let j=0;
  for(let i=0;i<target.length;i++) {
    const t=target[i];while(j+1<x.length&&x[j+1]<t)j++;
    const v=t<=x[0]?y[0]:j+1===x.length?y[j]:y[j]+(t-x[j])*(y[j+1]-y[j])/(x[j+1]-x[j]);
    output[i]=Math.max(output[i],v);
  }
}
/** Synchronous numerical core. Use ShaperFitExecutor from a live host. */
export function fitInputShapers(datasets:ShaperDataset[],options:FitOptions={}):ShaperFit {
  if(!datasets.length||datasets.length>16)throw new RangeError('Expected 1 to 16 calibration datasets');datasets.forEach(validateDataset);
  if(datasets.reduce((n,d)=>n+d.frequencies.length,0)>2_000_000)throw new RangeError('Fit input budget exceeded');
  if(!datasets.some(d=>d.psd.some(p=>p>0)))throw new RangeError('No measurable vibration energy');
  const names=options.shapers??['zv','mzv','ei','2hump_ei','3hump_ei'];
  if(!names.length||names.length>16||new Set(names).size!==names.length)throw new RangeError('Invalid shaper selection');
  const damping=options.damping??.1,drs=options.testDamping??[.075,.1,.15],scv=options.squareCornerVelocity??5;
  if(!nonnegative(damping)||damping>=1||!nonnegative(scv)||!drs.length||drs.length>16||drs.some(d=>!nonnegative(d)||d>=1))throw new RangeError('Invalid damping or corner velocity');
  for(const n of [options.maxSmoothing,options.maxVibrations,options.maxFrequency])if(n!==undefined&&!nonnegative(n))throw new RangeError('Invalid fit limit');
  if(options.frequencies&&options.range)throw new RangeError('Choose frequency list or range');
  let best:FitResult|undefined;const shapers:FitResult[]=[],candidates:FitResult[][]=[];let cells=0;
  for(const name of names) {
    const parsed=parseShaperName(name),config=shaperConfigs[parsed.name];
    const end=options.range?.end??150,start=Math.min(options.range?.start??config.minFrequency,end-1e-7);
    const tests=options.frequencies??grid(start,end,options.range?.step??.2);
    if(!tests.length||tests.length>10000||tests.some((f,i)=>!Number.isFinite(f)||f<=0||(i>0&&f<=tests[i-1])))throw new RangeError('Test frequencies must increase');
    const maxFrequency=Math.max(options.maxFrequency||200,tests.at(-1)!);
    let minFrequency=maxFrequency;
    const data=datasets.map(d=>{
      minFrequency=Math.min(minFrequency,d.frequencies[0]);
      const length=d.frequencies.findIndex(f=>f>maxFrequency),n=length<0?d.frequencies.length:length;
      if(!n)throw new RangeError('Dataset has no frequency bins in fit range');
      return {frequencies:d.frequencies.subarray(0,n),psd:d.psd.subarray(0,n)};
    });
    const bins=Float64Array.from(grid(minFrequency,maxFrequency,.2));
    cells+=tests.length*bins.length;if(cells>8_000_000)throw new RangeError('Fit output budget exceeded');
    let minimum:FitResult|undefined,selected:FitResult|undefined;const results:FitResult[]=[];
    for(let index=tests.length-1;index>=0;index--) {
      const frequency=tests[index],shaper=inputShaper(parsed.name,frequency,damping,parsed.options),smoothing=shaperSmoothing(shaper,5000,scv);
      if(options.maxSmoothing&&smoothing>options.maxSmoothing&&minimum){selected=minimum;break;}
      let vibrations=0;const values=new Float64Array(bins.length);
      for(const dataset of data) {
        const vals=new Float64Array(dataset.frequencies.length);
        for(const dr of drs){const r=remainingVibrations(shaper,dr,dataset.frequencies,dataset.psd);vibrations=Math.max(vibrations,r.vibrations);for(let i=0;i<vals.length;i++)vals[i]=Math.max(vals[i],r.response[i]);}
        interpolate(bins,dataset.frequencies,vals,values);
      }
      const score=smoothing*(vibrations**1.5+vibrations*.2+.01),maxAcceleration=shaperMaxAcceleration(shaper,scv);
      if(!Number.isFinite(score)||maxAcceleration===null)throw new RangeError('Invalid fit result');
      const result={name,frequency,frequencies:bins,values,vibrations,smoothing,score,maxAcceleration};results.push(result);
      if(!minimum||minimum.vibrations>vibrations)minimum=result;
    }
    if(!minimum)throw new Error('No shaper candidate');
    if(!selected) {
      selected=minimum;
      for(let i=results.length-1;i>=0;i--){const r=results[i];if(r.vibrations<minimum.vibrations*1.1+.0005&&(r.score<selected.score||(options.maxVibrations!==undefined&&minimum.vibrations>options.maxVibrations)))selected=r;}
    }
    if(!best||selected.score*1.2<best.score||(selected.score*1.05<best.score&&selected.smoothing*1.1<best.smoothing)
        ||(options.maxVibrations!==undefined&&best.vibrations>options.maxVibrations&&selected.vibrations<best.vibrations))best=selected;
    for(let i=results.length-1;i>=0;i--){const r=results[i];if(r.vibrations<best.vibrations&&r.smoothing<best.smoothing)best=selected=r;}
    shapers.push(selected);candidates.push(results);
  }
  if(best!.name==='zv')for(const result of shapers)if(result.name!=='zv'&&result.vibrations*1.1<best!.vibrations){best=result;break;}
  return {best:best!,shapers,candidates};
}
