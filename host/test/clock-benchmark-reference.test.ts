import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clockBenchmarkReference,decodeClockBenchmarkReference} from './helpers/clock-benchmark-reference.ts';
const bytes=readFileSync(new URL('../contracts/clock-benchmark-python-reference.json.gz',import.meta.url)),reference=decodeClockBenchmarkReference(bytes);
test('frozen clock suite retains both sample modes, secondary maps and all calibrated integer packet histories',()=>{
 for(const capture of reference.captures){const actual=clockBenchmarkReference<{results:unknown[];times:number[]}>(capture.name,capture.input);assert.deepEqual(actual,JSON.parse(capture.output));assert.equal(actual.results.length,capture.name==='clock-calibration'?4:5000);assert.equal(actual.times.length,11);}
});
test('clock suite refuses unknown profiles and mismatched numerical input',()=>{
 assert.throws(()=>clockBenchmarkReference('uncaptured','[]'),/Missing independent/);
 const periodic=reference.captures[0],demand=reference.captures[1];assert.throws(()=>clockBenchmarkReference(periodic.name,demand.input),/reference input changed/);
 const calibration=reference.captures[3],fixtures=JSON.parse(calibration.input);fixtures[2].initialClock++;
 assert.throws(()=>clockBenchmarkReference(calibration.name,JSON.stringify(fixtures)),/reference input changed/);
});
test('clock suite refuses corrupt and truncated capsules before trusting any result',()=>{
 const corrupt=Buffer.from(bytes);corrupt[100]^=1;assert.throws(()=>decodeClockBenchmarkReference(corrupt),/reference capsule changed/);
 assert.throws(()=>decodeClockBenchmarkReference(bytes.subarray(0,bytes.length-1)),/reference capsule changed/);
});
