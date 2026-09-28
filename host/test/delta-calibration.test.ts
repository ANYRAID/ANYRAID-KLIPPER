import test from 'node:test';
import assert from 'node:assert/strict';
import {DeltaCalibration,fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
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
