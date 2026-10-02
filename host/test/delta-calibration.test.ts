import {asymmetricDeltaCalibration} from './helpers/delta-calibration.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DeltaCalibration,fitDeltaCalibration,type DeltaCalibrationInput} from '../src/calibration/delta-calibration.ts';
import {DeltaCalibrationExecutor} from '../src/calibration/delta-calibration-executor.ts';
const geometry={radius:100,angles:[210,330,90] as const,arms:[250,250,250] as const,endstops:[300,300,300] as const,stepDistances:[.0125,.0125,.0125] as const};
function fixture(){const original=new DeltaCalibration(geometry),truth=new DeltaCalibration({...geometry,radius:100.2,endstops:[300.1,299.9,300.2]});const probes=Array.from({length:7},(_,i)=>{const angle=i*Math.PI/3,stable=original.stable(i?[Math.cos(angle)*65,Math.sin(angle)*65,0]:[0,0,0]);return {height:truth.position(stable)[2],stable};});return {geometry,probes};}
test('Delta calibration retains stable step coordinates across geometry changes',()=>{
 const original=new DeltaCalibration(geometry),p=[25,-30,10] as const,stable=original.stable(p),actual=original.position(stable);
 actual.forEach((v,i)=>assert(Math.abs(v-p[i])<1e-10));assert(Object.isFrozen(original.geometry.arms));assert.throws(()=>original.stable([1000,1000,0]));assert.throws(()=>new DeltaCalibration({...geometry,stepDistances:[0,1,1]}));
 assert.deepEqual(original.parameters().adjustable,['radius','angle_a','angle_b','endstop_a','endstop_b','endstop_c']);assert.equal(original.parameters(true).adjustable.length,9);
});
test('Delta fit recovers synthetic height constraints without mutating inputs or fixed geometry',()=>{
 const input=fixture(),before=structuredClone(input),result=fitDeltaCalibration(input);assert.deepEqual(input,before);assert(result.initialError>.01);assert(result.finalError<1e-9);assert(result.heightResiduals.every(e=>Math.abs(e)<2e-5));assert.deepEqual(result.geometry.arms,geometry.arms);assert.deepEqual(result.geometry.stepDistances,geometry.stepDistances);assert.equal(result.geometry.angles[2],90);
 for(const value of [{...input,probes:[]},{...input,probes:[...input.probes,{height:NaN,stable:[0,0,0] as const}]},{...input,distances:[{distance:0,first:[0,0,0] as const,second:[0,0,0] as const}]}])assert.throws(()=>fitDeltaCalibration(value));
});
test('Delta worker isolates fitting and releases its slot after cancellation, timeout and malformed input',async()=>{
 const executor=new DeltaCalibrationExecutor(),input=fixture(),abort=new AbortController(),running=executor.fit(input,{signal:abort.signal});assert(executor.busy);await assert.rejects(executor.fit(input),/busy/);abort.abort(new Error('cancel calibration'));await assert.rejects(running,/cancel calibration/);assert.equal(executor.busy,false);
 await assert.rejects(executor.fit(input,{timeoutMs:1}),/timed out/);assert.equal(executor.busy,false);await assert.rejects(executor.fit({...input,probes:[]}),/measurement count/);
 const result=await executor.fit(input);assert(result.finalError<1e-9);assert.equal(executor.busy,false);
});

test('Delta worker converges extended fit and rejects repeated constraints',async()=>{
 const executor=new DeltaCalibrationExecutor(),input=asymmetricDeltaCalibration()[1];
 const result=await executor.fit(input);assert(result.search.converged);assert(result.finalError<1e-18);assert(result.search.rounds<10);assert.equal(executor.busy,false);
 await assert.rejects(executor.fit({...input,probes:Array(7).fill(input.probes[0]),distances:[]}),/independent calibration constraints/);assert.equal(executor.busy,false);
 const original=new DeltaCalibration(input.geometry),actual=new DeltaCalibration(result.geometry),truth=new DeltaCalibration({...input.geometry,radius:100.2,endstops:[300.1,300.1,300.1]});
 for(const z of [0,25,100])for(const x of [-40,0,40]){const stable=original.stable([x,20,z]),a=actual.position(stable),b=truth.position(stable);a.forEach((v,i)=>assert(Math.abs(v-b[i])<1e-7));}
});
test('Delta noisy overdetermined fit improves residuals with finite geometry',()=>{
 const input=asymmetricDeltaCalibration()[1];
 const noisy={...input,probes:input.probes.map((p,i)=>({...p,height:p.height+Math.sin(i*7)*.001})),distances:input.distances!.map((d,i)=>({...d,distance:d.distance+Math.cos(i*3)*.001}))};
 const before=structuredClone(noisy),result=fitDeltaCalibration(noisy);assert.deepEqual(noisy,before);assert(result.search.converged);assert(result.finalError<result.initialError*.001);assert(result.heightResiduals.every(v=>Math.abs(v)<.002));assert(result.distanceResiduals.every(v=>Math.abs(v)<.003));
});

test('captured small-span Delta input cannot publish a one-step unconverged fit despite reduced residuals',async()=>{
 const input=JSON.parse(readFileSync(new URL('./helpers/delta-calibration-sensitive-input.json',import.meta.url),'utf8')).input as DeltaCalibrationInput,before=structuredClone(input),perturbed=structuredClone(input);
 perturbed.probes=perturbed.probes.map((p,i)=>i? p:{...p,stable:[p.stable[0]-1,p.stable[1],p.stable[2]]});
 const result=fitDeltaCalibration(perturbed);assert.equal(result.search.converged,false);assert.equal(result.search.reason,'line_search_failed');assert(result.finalError<result.initialError);assert.deepEqual(input,before);
 const executor=new DeltaCalibrationExecutor();await assert.rejects(executor.fit(perturbed),/Delta calibration did not converge: line_search_failed/);assert.equal(executor.busy,false);
 const base=await executor.fit(input);assert(base.search.converged);assert(base.finalError<1e-18);assert.equal(executor.busy,false);assert.deepEqual(input,before);
});
