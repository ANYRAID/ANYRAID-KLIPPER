import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {clockRuntimeReference,decodeClockRuntimeReference} from './helpers/clock-runtime-reference.ts';
const bytes=readFileSync(new URL('../contracts/clock-runtime-python-reference.json.gz',import.meta.url));
const captured=decodeClockRuntimeReference(bytes);
test('frozen clock runtime reference retains the original unknown warmup sample and all independent estimates',()=>{
 const input=JSON.parse(captured.input),output=clockRuntimeReference(captured.input);
 assert.equal(input.length,5009);assert.equal(output.length,5008);assert.deepEqual(output,JSON.parse(captured.output));
 assert.equal(input.filter((row:{sentTime:number})=>row.sentTime===0).length,1);assert.equal(input[7].sentTime,0);
});
test('clock runtime reference refuses changed clock input instead of generating replacement truth',()=>{
 const input=JSON.parse(captured.input);input[100].clock32++;
 assert.throws(()=>clockRuntimeReference(JSON.stringify(input)),/reference input changed/);
 input[100].clock32--;input[100].receiveTime+=.001;
 assert.throws(()=>clockRuntimeReference(JSON.stringify(input)),/reference input changed/);
});
test('clock runtime reference refuses corrupted or truncated independent artifacts',()=>{
 const corrupted=Buffer.from(bytes);corrupted[corrupted.length-1]^=1;
 assert.throws(()=>decodeClockRuntimeReference(corrupted),/reference capsule changed/);
 assert.throws(()=>decodeClockRuntimeReference(bytes.subarray(0,bytes.length-1)),/reference capsule changed/);
});
