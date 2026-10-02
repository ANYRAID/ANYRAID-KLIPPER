import test from 'node:test';
import assert from 'node:assert/strict';
import {motanDerivative,motanIntegral,motanNorm2,motanSmooth,motanCombine} from '../src/motan/derived-math.ts';
import {derivedOracle} from './helpers/motan-derived-oracle.ts';
import type {DerivedInput} from './helpers/motan-derived-oracle.ts';
export function calculate(input:DerivedInput):Float64Array{switch(input.kind){case 'derivative':return motanDerivative(input.source,input.segment);case 'integral':return motanIntegral(input.source,input.segment,input.second,input.halfLife);case 'norm2':return motanNorm2([input.source,input.second!,...input.third?[input.third]:[]]);case 'smooth':return motanSmooth(input.source,input.segment,input.smoothTime);default:return motanCombine(input.source,input.second!,input.kind);}}
test('Motan derivative, integral, norms and kinematic combinations retain original Python numerical order',()=>{
 const source=Array.from({length:513},(_,i)=>Math.sin(i*.07)*20+.25),second=Array.from({length:513},(_,i)=>Math.cos(i*.05)*30-.5),third=Array.from({length:513},(_,i)=>i*.013);for(const kind of ['derivative','integral','norm2','smooth','deviation','corexy_x','corexy_y','kin_x','kin_y'] as const){const input={kind,source,second,third,segment:.001},expected=derivedOracle(input).values;assert.deepEqual(Array.from(calculate(input)),expected,kind);}
 for(const halfLife of [0,.003,1]){const input:DerivedInput={kind:'integral',source,second,segment:.001,halfLife};assert.deepEqual(Array.from(calculate(input)),derivedOracle(input).values);}const input:DerivedInput={kind:'integral',source,segment:.001};assert.deepEqual(Array.from(calculate(input)),derivedOracle(input).values);
});
test('Motan smoothing preserves ties-to-even windows and original asymmetric edge weights',()=>{
 for(const smoothTime of [.004,.005,.007,.01]){const input:DerivedInput={kind:'smooth',source:[1,2,4,8,16,32,64],segment:.001,smoothTime};assert.deepEqual(Array.from(calculate(input)),derivedOracle(input).values);}assert.throws(()=>motanSmooth([1,2],.01,.01),/resolution/);assert.throws(()=>motanSmooth(new Float64Array(10000),.001,10),/work limit/);
});
test('Motan integral uses compensated Float64 mean and keeps zip truncation without mutating source',()=>{
 const input:DerivedInput={kind:'integral',source:[1e16,1,-1e16,3,.5],segment:.001};assert.deepEqual(Array.from(calculate(input)),derivedOracle(input).values);const a=[1,2,3],b=[4,5];assert.deepEqual(Array.from(motanCombine(a,b,'corexy_y')),[-1.5,-1.5]);assert.deepEqual(a,[1,2,3]);assert.throws(()=>motanIntegral(a,.001,b),/length/);assert.throws(()=>motanNorm2([a,b]),/shorter/);
});
test('Motan numeric kernels reject undefined samples, invalid resolution and nonfinite output',()=>{
 assert.throws(()=>motanDerivative([1],.001),/two samples/);assert.throws(()=>motanIntegral([],1),/needs samples/);assert.throws(()=>motanDerivative([1,2],0),/segment/);assert.throws(()=>motanNorm2([[1,Infinity],[2,3]]),/finite/);assert.throws(()=>motanIntegral([1,2],.001,undefined,-1),/half-life/);assert.throws(()=>motanCombine([Number.MAX_VALUE],[Number.MAX_VALUE],'kin_x'),/finite range/);assert.deepEqual(Array.from(motanSmooth([],.001)),[]);
});
