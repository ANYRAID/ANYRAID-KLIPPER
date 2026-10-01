import {motanSOSReference} from './motan-sos-reference.ts';
import type {MotanSOSMode} from '../../src/motan/sos-filter.ts';
export interface SOSCase {
  kind: 'lowpass' | 'highpass' | 'bandpass' | 'notch';
  order:number; cutoff:number|number[]; source:number[];
  mode:MotanSOSMode; fs?:number;
}
export interface SOSReference {sos:number[][]; values:number[]; ms:number[]; preciseValues?:number[];}
/** Fixed SciPy coefficients/results and optional 80-digit mpmath results.
 * ms contains captured reference timing, never a current run. */
export function sosOracle(cases:SOSCase[],bench=false,highPrecision=false):SOSReference[] {
  return cases.map(c=>motanSOSReference<SOSReference>('sos',{case:c,bench,highPrecision}));
}
