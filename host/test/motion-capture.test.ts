import test from 'node:test';
import assert from 'node:assert/strict';
import {serialize} from 'node:v8';
import {readFileSync} from 'node:fs';
import {inspectMotionCapture} from '../src/diagnostics/motion-capture.ts';
test('archived real mismatch preserves hash and does not invent missing input evidence',()=>{
 const result=inspectMotionCapture(readFileSync(new URL('../../docs/diagnostics/node26-motion-capture-20260928/motion-mismatch-340545-6.bin.gz',import.meta.url)));assert.equal(result.rawSHA256,'198a0c2e93ca49d8918785e3ce0b1ff3b88c186352491cfb6f5046b9ee71f0ba');assert.equal(result.sameInvocationInputs,false);assert.equal(result.index,10857);assert.equal(result.differences[0].count,0);assert.deepEqual(result.differences.filter(d=>d.count).map(d=>[d.stage,d.count]),[['reference panel 0 curve 1',1],['reference panel 1 curve 1',2]]);
});
test('same-invocation stages distinguish derivative corruption from panel copy corruption',()=>{
 const input=[1,1,1],velocity=Array.from({length:4},()=>[0,0,0]),acceleration=Array.from({length:4},()=>[0,0,0]);velocity[1][1]=.25;acceleration[1]=[0,2500,-2500];
 const panels=[velocity,acceleration].map(group=>({plot:{curves:group.map(values=>({values:[...values]}))}}));panels[0].plot.curves[2].values[2]=1;
 const result=inspectMotionCapture(serialize({version:2,positions:input,reference:{positions:input,panels:panels.map(p=>({curves:p.plot.curves.map(()=>({values:[0,0,0]}))}))},stages:{nominal:input,updated:input,head:input,newHead:input,velocity,acceleration},panels}));const failures=result.differences.filter(d=>d.count&&!d.stage.startsWith('reference'));assert.deepEqual(failures.map(d=>d.stage),['velocity 1 vs captured input derivative','velocity panel 2 vs raw stage']);assert.equal(failures[0].examples[0].actualBits,'0x3fd0000000000000');
});
