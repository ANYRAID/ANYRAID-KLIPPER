import test from 'node:test';
import assert from 'node:assert/strict';
import {collectProbeSamples,type ProbeSamples} from '../src/homing/probe-samples.ts';
const policy:ProbeSamples={samples:3,retractDistance:2,liftSpeed:5,tolerance:.1,retries:1,result:'average'};
const signal=new AbortController().signal;
test('sampling discards the entire out-of-tolerance batch and retracts from halt',async()=>{
 const zs=[1,1.2,1.01,1.02,1.03],moves:readonly number[][]=[];let i=0;
 const result=await collectProbeSamples(policy,async()=>{const z=zs[i++];return {trigger:[10,20,z,0],halt:[10,20,z-.03,0]};},async p=>{(moves as number[][]).push([...p]);},signal);
 assert.equal(result.retries,1);assert.equal(result.attempts,5);assert.equal(result.position[2],1.02);assert.equal(moves.length,4);assert.equal(moves[0][2],.97+2);
});
for(const [zs,expected] of [[[3,1,2],2],[[4,1,3,2],2.5]] as [number[],number][])test(`median uses central samples (${zs.length})`,async()=>{
 let i=0;const result=await collectProbeSamples({...policy,samples:zs.length,tolerance:10,result:'median'},async()=>({trigger:[0,0,zs[i++],0],halt:[0,0,0,0]}),async()=>{},signal);assert.equal(result.position[2],expected);
});
test('exhausted tolerance and cancellation do not return a partial result',async()=>{
 let i=0;await assert.rejects(collectProbeSamples({...policy,retries:0},async()=>({trigger:[0,0,i++,0],halt:[0,0,0,0]}),async()=>{},signal),/tolerance/);
 const c=new AbortController();await assert.rejects(collectProbeSamples(policy,async()=>{c.abort(new Error('cancel samples'));return {trigger:[0,0,0,0],halt:[0,0,0,0]};},async()=>assert.fail('must not retract'),c.signal),/cancel samples/);
});
test('probe batches preserve additional filament axes and reject a changing coordinate shape',async()=>{
 const policy={samples:2,retractDistance:1,liftSpeed:5,tolerance:.1,retries:0,result:'average' as const},signal=new AbortController().signal;
 const result=await collectProbeSamples(policy,async()=>({trigger:[1,2,3,4,5],halt:[1,2,3,4,5]}),async p=>{assert.deepEqual(p,[1,2,4,4,5]);},signal);assert.deepEqual(result.position,[1,2,3,4,5]);
 let n=0;await assert.rejects(collectProbeSamples(policy,async()=>{const p=++n===1?[1,2,3,4]:[1,2,3,4,5];return {trigger:p,halt:p};},async()=>{},signal),/coordinates/);
});
