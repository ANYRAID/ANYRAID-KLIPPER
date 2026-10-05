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

test('exact remote Delta failures reproduce unconverged fitting and never escape the worker as a candidate',async t=>{
 const evidence=JSON.parse(readFileSync(new URL('../contracts/node-host-integration-candidate.json',import.meta.url),'utf8'));
 const sources=['1e88895bef6bc03c5ec4b9f528e88777e8fb7928','570ee60d6e9300fe37ed10370f3439de15b46881'];
 const captures=sources.map(source=>{
  const observation=evidence.remoteCiObservation.additionalObservations.find((o:{source:string})=>o.source===source);
  assert(observation,'Missing authoritative remote observation '+source);
  const failure=observation.host.failures.find((f:{test:string})=>f.test==='Delta automatic product service exposes tokenized two-sample probing (run=0)');
  assert.equal(failure.stage,'fit');assert.equal(failure.cause,'Delta calibration did not converge: line_search_failed');
  return failure.input as DeltaCalibrationInput;
 });
 const numbers=(input:DeltaCalibrationInput)=>[input.geometry.radius,...input.geometry.angles,...input.geometry.arms,...input.geometry.endstops,...input.geometry.stepDistances,...input.probes.flatMap(p=>[p.height,...p.stable])];
 const first=numbers(captures[0]),second=numbers(captures[1]);assert.equal(first.length,41);assert.equal(second.length,41);assert(first.every((v,i)=>Object.is(v,second[i])));
 const input=captures[0],before=structuredClone(input),result=fitDeltaCalibration(input);
 assert.equal(result.search.converged,false);assert.equal(result.search.reason,'line_search_failed');
 assert(result.finalError<result.initialError);assert.deepEqual(input,before);
 // Reduced residuals do not authorize publishing or persisting geometry.
 const executor=new DeltaCalibrationExecutor();
 await assert.rejects(executor.fit(input),/Delta calibration did not converge: line_search_failed/);
 assert.equal(executor.busy,false);assert.deepEqual(input,before);
 const successful=JSON.parse(readFileSync(new URL('./helpers/delta-calibration-sensitive-input.json',import.meta.url),'utf8')).input as DeltaCalibrationInput;
 const candidate=await executor.fit(successful);assert(candidate.search.converged);assert(candidate.finalError<1e-18);assert.equal(executor.busy,false);
 t.diagnostic('RemoteDeltaFitDiscriminator '+JSON.stringify({sources,values:first.length,reason:result.search.reason,rounds:result.search.rounds,condition:result.search.condition,initialError:result.initialError,finalError:result.finalError,workerRejected:true,successfulControlConverged:true}));
});


test('latest captured small-radius Delta fit stays rejected while a well-spaced control converges',async t=>{
 const evidence=JSON.parse(readFileSync(new URL('../contracts/fixed-client-bundle-acceptance.json',import.meta.url),'utf8'));
 const capture=evidence.integratedCandidate.deltaSaveFixtureRepair.validation.capturedFailedFit;
 assert.equal(capture.sourceHead,'5536850a3ed085b02df4cb3dfa376a738e009f3b');assert.equal(capture.sourceJob,111703189526);
 const input:DeltaCalibrationInput={geometry:capture.geometry,probes:capture.stable.map((stable:DeltaCalibrationInput['probes'][number]['stable'])=>({height:capture.height,stable})),manual:capture.manual,distances:capture.distances};
 const before=structuredClone(input),result=fitDeltaCalibration(input);
 assert.equal(result.search.converged,false);assert.equal(result.search.reason,'line_search_failed');assert(result.finalError>1);assert.deepEqual(input,before);
 const executor=new DeltaCalibrationExecutor();await assert.rejects(executor.fit(input),/Delta calibration did not converge: line_search_failed/);assert.equal(executor.busy,false);assert.deepEqual(input,before);
 // Change only the spatial extent of these same observed Z errors. This is
 // an offline conditioning control, not a replacement measurement or fit.
 const model=new DeltaCalibration(input.geometry),control={...input,probes:input.probes.map(p=>{const [x,y,z]=model.position(p.stable);return {...p,stable:model.stable([x*32.5,y*32.5,z])};})};
 const candidate=await executor.fit(control);assert(candidate.search.converged);assert(candidate.finalError<candidate.initialError);assert(candidate.search.condition<10);assert.equal(executor.busy,false);
 t.diagnostic('LatestDeltaFitDiscriminator '+JSON.stringify({source:capture.sourceHead,job:capture.sourceJob,values:41,reason:result.search.reason,rounds:result.search.rounds,condition:result.search.condition,initialError:result.initialError,finalError:result.finalError,workerRejected:true,spatialControlConverged:true,spatialControlCondition:candidate.search.condition,scope:'Captured failure and offline spatial conditioning only; does not close wire timing or physical precision'}));
});
