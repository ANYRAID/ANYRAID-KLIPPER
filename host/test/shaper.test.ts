import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inputShaper,parseShaperName,shaperConfigs} from '../src/motion/shaper.ts';
import type {ShaperName} from '../src/motion/shaper.ts';
import {shaperResponse,remainingVibrations,shaperMaxAcceleration,shaperSmoothing} from '../src/calibration/shaper.ts';
test('all shapers retain finite increasing pulses at their supported damping limits',()=>{
 for(const name of Object.keys(shaperConfigs) as ShaperName[])for(const damping of [0,.1,shaperConfigs[name].maxDamping]) {
  const s=inputShaper(name,40,damping);
  assert(s.amplitudes.every(Number.isFinite));assert(s.times.every((t,i)=>i===0?t===0:t>s.times[i-1]));
  assert(Math.abs(shaperResponse(s,damping,new Float64Array([0]))[0]-1)<1e-14);
  assert.throws(()=>inputShaper(name,40,shaperConfigs[name].maxDamping+.001));
 }
});
test('ZV analytical cancellation and shaper frequency scaling',()=>{
 const s=inputShaper('zv',50,0);assert.deepEqual(s,{amplitudes:[1,1],times:[0,.01]});
 assert(shaperResponse(s,0,new Float64Array([50]))[0]<1e-15);
 const fast=inputShaper('mzv',80,.1),slow=inputShaper('mzv',40,.1);
 assert.deepEqual(fast.amplitudes,slow.amplitudes);assert.deepEqual(fast.times.map(t=>t*2),slow.times);
});
test('MZV coefficient cache cannot be mutated by callers and enforces native limits',()=>{
 const s=inputShaper('mzv',40,.1);s.amplitudes.fill(99);s.times.fill(99);
 assert(inputShaper('mzv',40,.1).amplitudes.every(a=>a<2));
 for(const options of [{n:2},{n:11},{n:3.1},{t:1},{t:-1},{tau:NaN}])assert.throws(()=>inputShaper('mzv',40,.1,options));
 assert.throws(()=>inputShaper('zv',40,.1,{n:3}));
 for(const f of [NaN,Infinity,-1,Number.MIN_VALUE])assert.throws(()=>inputShaper('zv',f));
});
test('legacy shaper import is strict and maps supported parameters',()=>{
 assert.deepEqual(parseShaperName('mzv(n=5, tau=1.5)'),{name:'mzv',options:{n:5,tau:1.5}});
 assert.deepEqual(parseShaperName('ei(.05)'),{name:'ei',options:{vTolerance:.05}});
 for(const value of ['mzv(-3)','mzv(3,t=.75)','mzv(n=3,n=4)','mzv(n=3oops)','mzv(3,,.75)','zv(n=3)','missing','mzv(n=3)trash'])assert.throws(()=>parseShaperName(value));
});
test('smoothing acceleration bound satisfies threshold and disabled/silent input is explicit',()=>{
 const s=inputShaper('zvd',40,.1),accel=shaperMaxAcceleration(s)!;
 assert(shaperSmoothing(s,accel)<=.12);assert(shaperSmoothing(s,accel+1e-6)>.12);
 assert.equal(shaperMaxAcceleration(s,1000),0);
 const none=inputShaper('zv',0);assert.equal(shaperMaxAcceleration(none),null);assert.equal(shaperSmoothing(none),0);
 assert.deepEqual([...shaperResponse(none,.1,new Float64Array([0,20,50]))],[1,1,1]);
 assert.equal(remainingVibrations(s,.1,new Float64Array([0,20]),new Float64Array([0,0])).vibrations,0);
 assert.throws(()=>shaperResponse(s,.1,new Float64Array([-1])));
 assert.throws(()=>remainingVibrations(s,.1,new Float64Array([20]),new Float64Array([-1])));
});
test('extreme damping terminates acceleration search and PSD overflow is rejected',()=>{
 const shaper=inputShaper('zv',200,.99),accel=shaperMaxAcceleration(shaper)!;
 assert(Number.isFinite(accel));assert(shaperSmoothing(shaper,accel)<=.12);
 assert.throws(()=>remainingVibrations(shaper,.1,new Float64Array([20,40,60]),new Float64Array([1e308,1e308,1e308])),/overflow/);
});
test('parameterized undamped MZV satisfies the prescribed frequency zeros',()=>{
 for(let n=3;n<=10;n++) {
  const t=.75,tau=t*(n-2)/(n-2*t-1),shaper=inputShaper('mzv',40,0,{n,t});
  const zeros=Float64Array.from({length:n-1},(_,i)=>40*(1+i/tau));
  assert([...shaperResponse(shaper,0,zeros)].every(v=>v<1e-12));
 }
});
