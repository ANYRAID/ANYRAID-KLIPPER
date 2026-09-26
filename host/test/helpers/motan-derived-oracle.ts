// Fixed original CPython reference; no Python or Git execution.
import {motanMathReference} from './motan-math-reference.ts';
export type DerivedKind='derivative'|'integral'|'norm2'|'smooth'|'deviation'|'corexy_x'|'corexy_y'|'kin_x'|'kin_y';
export interface DerivedInput {kind:DerivedKind;source:number[];second?:number[];third?:number[];segment:number;halfLife?:number;smoothTime?:number;}
export function derivedOracle(input:DerivedInput,bench=false):{values:number[];ms:number[]}{return motanMathReference('derived',{input,bench});}
