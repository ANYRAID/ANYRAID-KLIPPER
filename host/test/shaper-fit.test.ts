import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fitInputShapers,normalizeShaperDataset} from '../src/calibration/shaper-fit.ts';
import {ShaperFitExecutor} from '../src/calibration/shaper-fit-executor.ts';
const dataset=()=>({frequencies:Float64Array.from({length:128},(_,i)=>i*2),psd:Float64Array.from({length:128},(_,i)=>Math.exp(-(((i*2-45)/8)**2))+.01)});
const options={shapers:['mzv','ei'],frequencies:[35,40,45,50]};
test('fitting retains candidate ordering and rejects invalid data/budgets',()=>{
 const result=fitInputShapers([dataset()],options);assert.equal(result.shapers.length,2);assert(result.shapers.includes(result.best));
 assert.deepEqual(result.candidates[0].map(c=>c.frequency),[50,45,40,35]);
 const data=dataset();data.frequencies[10]=data.frequencies[9];assert.throws(()=>fitInputShapers([data],options));
 assert.throws(()=>fitInputShapers([dataset()],{frequencies:[50,40]}));
 assert.throws(()=>fitInputShapers([dataset()],{range:{step:1e-9}}));
 assert.throws(()=>fitInputShapers([dataset()],{shapers:[]}));
});
test('normalization returns independent buffers and suppresses low-frequency noise',()=>{
 const input=dataset(),before=input.psd.slice(),result=normalizeShaperDataset(input);
 assert.deepEqual(input.psd,before);assert.notEqual(result.psd.buffer,input.psd.buffer);
 assert.equal(result.psd[0],0);assert.equal(result.psd[20],input.psd[20]/40.1);
});
test('worker fitting matches direct calculation and releases transferred ownership',async()=>{
 const data=dataset(),expected=fitInputShapers([dataset()],options),executor=new ShaperFitExecutor();
 const result=await executor.fit([data],options);assert.equal(data.psd.byteLength,0);assert.deepEqual(result,expected);assert.equal(executor.busy,false);
});
test('worker cancellation, timeout, and invalid input release the execution slot',async()=>{
 const executor=new ShaperFitExecutor(),controller=new AbortController();
 const pending=executor.fit([dataset()],{}, {signal:controller.signal});
 await assert.rejects(executor.fit([dataset()],options),/busy/);controller.abort(new Error('cancelled by test'));
 await assert.rejects(pending,/cancelled by test/);assert.equal(executor.busy,false);
 await assert.rejects(executor.fit([dataset()],{}, {timeoutMs:1}),/timed out/);assert.equal(executor.busy,false);
 await assert.rejects(executor.fit([dataset()],{shapers:['unknown']}),/Unknown/);assert.equal(executor.busy,false);
 const result=await executor.fit([dataset()],options);assert(Number.isFinite(result.best.score));
});
test('silent spectra cannot produce a misleading recommendation and normalization overflow fails',()=>{
 const data=dataset();data.psd.fill(0);assert.throws(()=>fitInputShapers([data],options),/No measurable/);
 data.psd[0]=1e308;assert.throws(()=>normalizeShaperDataset(data),/overflow/);
});
