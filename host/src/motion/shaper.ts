// Input shaper definitions from klippy/extras/shaper_defs.py.
// Copyright (C) 2020-2026 Dmitry Butyugin. GNU GPLv3.
import {pseudoInverse} from '../math/mathutil.ts';
export interface Shaper {amplitudes: number[]; times: number[]}
export type ShaperName = 'zv' | 'mzv' | 'zvd' | 'ei' | '2hump_ei' | '3hump_ei';
export const shaperConfigs: Readonly<Record<ShaperName, {minFrequency: number; maxDamping: number}>> = Object.freeze({
  zv: Object.freeze({minFrequency:21,maxDamping:.99}), mzv:Object.freeze({minFrequency:23,maxDamping:.99}),
  zvd:Object.freeze({minFrequency:29,maxDamping:.99}), ei:Object.freeze({minFrequency:29,maxDamping:.4}),
  '2hump_ei':Object.freeze({minFrequency:39,maxDamping:.3}), '3hump_ei':Object.freeze({minFrequency:48,maxDamping:.2}),
});
export interface ShaperOptions {n?: number; t?: number; tau?: number; vTolerance?: number}
const coefficients = new Map<string, Shaper>();
function finite(value: number, label: string): void {if (!Number.isFinite(value)) throw new RangeError(`Nonfinite ${label}`);}
export function validateShaper(shaper: Shaper): void {
  const {amplitudes:a,times:t}=shaper;
  if(a.length!==t.length || a.length>10)throw new RangeError('Shaper must fit the native ten-pulse limit');
  let total=0;
  for(let i=0;i<a.length;i++) {
    if(!Number.isFinite(a[i]) || a[i]<-0.00001 || !Number.isFinite(t[i]) || t[i]<0 || (i>0 && t[i]<=t[i-1]))throw new RangeError('Invalid shaper amplitudes or pulse times');
    total+=a[i];
  }
  if(a.length && (!Number.isFinite(total) || total<=0))throw new RangeError('Invalid shaper gain');
}
function mzvCoefficients(n: number, t: number): Shaper {
  if(!Number.isInteger(n) || n<3 || n>10)throw new RangeError('MZV pulse count must be an integer from 3 to 10');
  if(!Number.isFinite(t) || t<=0 || n<=2*t+1+1e-7)throw new RangeError('Invalid MZV duration');
  const key=`${n}:${t}`,cached=coefficients.get(key);
  if(cached)return {amplitudes:[...cached.amplitudes],times:[...cached.times]};
  const tau=t*(n-2)/(n-2*t-1),times=Array.from({length:n},(_,i)=>i*t/(n-1));
  const matrix=[Array(n).fill(1) as number[]];
  for(let i=0;i<n-1;i++) {
    const angles=times.map(tj=>2*Math.PI*(1+i/tau)*tj);
    matrix.push(angles.map(Math.cos),angles.map(Math.sin));
  }
  const inverse=pseudoInverse(matrix);
  if(!inverse)throw new RangeError('Ill-formed MZV shaper');
  const amplitudes=inverse.map(row=>row[0]);
  const result={amplitudes,times};validateShaper(result);
  if(coefficients.size===32)coefficients.delete(coefficients.keys().next().value!);
  coefficients.set(key,{amplitudes:[...amplitudes],times:[...times]});
  return result;
}
const twoTimes=[[0,0,0,0],[.49890,.16270,-.54262,6.16180],[.99748,.18382,-1.58270,8.17120],[1.49920,-.09297,-.28338,1.85710]];
const twoAmplitudes=[[.16054,.76699,2.26560,-1.22750],[.33911,.45081,-2.58080,1.73650],[.34089,-.61533,-.68765,.42261],[.15997,-.60246,1.00280,-.93145]];
const threeTimes=[[0,0,0,0],[.49974,.23834,.44559,12.4720],[.99849,.29808,-2.36460,23.3990],[1.49870,.10306,-2.01390,17.0320],[1.99960,-.28231,.61536,5.40450]];
const threeAmplitudes=[[.11275,.76632,3.29160,-1.44380],[.23698,.61164,-2.57850,4.85220],[.30008,-.19062,-2.14560,.13744],[.23775,-.73297,.46885,-2.08650],[.11244,-.45439,.96382,-1.46000]];
/** Frequency zero disables shaping. Config minFrequency is an auto-tuning hint, not a safety floor. */
export function inputShaper(name: ShaperName, frequency: number, damping=.1, options: ShaperOptions={}): Shaper {
  if(!Object.hasOwn(shaperConfigs,name))throw new RangeError('Unknown shaper');
  finite(frequency,'frequency');finite(damping,'damping');
  if(frequency<0 || damping<0 || damping>shaperConfigs[name].maxDamping)throw new RangeError('Invalid shaper frequency or damping');
  const allowed=name==='mzv'?['n','t','tau']:name==='ei'?['vTolerance']:[];
  if(Object.keys(options).some(k=>!allowed.includes(k)))throw new RangeError('Unexpected shaper parameter');
  for(const value of Object.values(options))finite(value,'shaper parameter');
  // Validate all parameters even while disabled so invalid settings cannot be deferred.
  let mzv: Shaper | undefined;
  if(name==='mzv') {
    const n=options.n??3,tau=options.tau??0;
    if(tau<0 || (options.t??0)<0)throw new RangeError('Invalid MZV duration');
    const t=tau?tau*(n-1)/(n+2*tau-2):(options.t||.75);
    mzv=mzvCoefficients(n,t);
  }
  const tolerance=options.vTolerance??.05;
  if(name==='ei' && (tolerance<0 || tolerance>1))throw new RangeError('Invalid vibration tolerance');
  if(frequency===0)return {amplitudes:[],times:[]};
  const df=Math.sqrt(1-damping**2),period=1/(frequency*df),k=Math.exp(-damping*Math.PI/df);
  let result: Shaper;
  if(name==='zv')result={amplitudes:[1,k],times:[0,.5*period]};
  else if(name==='zvd')result={amplitudes:[1,2*k,k**2],times:[0,.5*period,period]};
  else if(name==='mzv') {
    result=mzv!;const n=result.times.length,t=result.times[n-1];
    const decay=Math.exp(-2*t*damping*Math.PI/((n-1)*df));let power=decay;
    for(let i=1;i<n;i++){result.times[i]*=period;result.amplitudes[i]*=power;power*=decay;}
  } else if(name==='ei') {
    const v=tolerance,dr=damping;
    const a1=(.24968+.24961*v)+((.80008+1.23328*v)+(.49599+3.17316*v)*dr)*dr;
    const a3=(.25149+.21474*v)+((-.83249+1.41498*v)+(.85181-4.90094*v)*dr)*dr;
    const t2=.4999+(((.46159+8.57843*v)*v)+(((4.26169-108.644*v)*v)+((1.75601+336.989*v)*v)*dr)*dr)*dr;
    result={amplitudes:[a1,1-a1-a3,a3],times:[0,t2*period,period]};
  } else {
    const poly=(c:number[])=>((c[3]*damping+c[2])*damping+c[1])*damping+c[0];
    const ts=name==='2hump_ei'?twoTimes:threeTimes,as=name==='2hump_ei'?twoAmplitudes:threeAmplitudes;
    result={times:ts.map(t=>poly(t)*(1/frequency)),amplitudes:as.map(poly)};
  }
  validateShaper(result);return result;
}
/** Strict import boundary for legacy names; products should persist typed parameters. */
export function parseShaperName(value: string): {name: ShaperName; options: ShaperOptions} {
  const match=/^([\w]+)(?:\s*\((.*)\))?$/.exec(value);
  if(!match || !Object.hasOwn(shaperConfigs,match[1]))throw new RangeError('Unknown shaper');
  const name=match[1] as ShaperName,options:ShaperOptions={};
  if(!match[2])return {name,options};
  const allowed=name==='mzv'?['n','t','tau']:name==='ei'?['v_tol']:[];
  let named: boolean | undefined;
  for(const [i,arg] of match[2].split(',').entries()) {
    const token=/^\s*(?:(\w+)\s*=\s*)?(\d+(?:\.\d*)?|\.\d+)\s*$/.exec(arg);
    if(!token || (named!==undefined && named!==!!token[1]))throw new RangeError('Malformed or mixed shaper parameters');
    named=!!token[1];const key=token[1]??allowed[i];
    if(!allowed.includes(key))throw new RangeError('Unknown shaper parameter');
    const target=(key==='v_tol'?'vTolerance':key) as keyof ShaperOptions;
    if(Object.hasOwn(options,target))throw new RangeError('Duplicate shaper parameter');
    options[target]=Number(token[2]);
  }
  return {name,options};
}
