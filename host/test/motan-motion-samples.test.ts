import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeStepBlock,stepPhase,MotanStepSampler,MotanTrapSampler} from '../src/motan/motion-samples.ts';
import type {TrapSelection} from '../src/motan/motion-samples.ts';
import {motionCase,oracle} from './helpers/motan-motion-oracle.ts';
test('Motan motion matches original Python sample-for-sample including wide clocks, reversals, gaps and EOF',async()=>{
 for(const smooth of [0,.001,.01,1]){const input=motionCase();input.smooth=smooth;const expected=oracle(input);let b=0,m=0;const step=new MotanStepSampler(async()=>input.blocks[b++]??null,smooth),trap=new MotanTrapSampler('x',async()=>input.moves[m++]??null);const a=[],c=[];for(const time of input.times){a.push(await step.sample(time));c.push(await trap.sample(time));}assert.deepEqual(a,expected.step);assert.deepEqual(c,expected.trap);const decoded=decodeStepBlock(input.blocks[0]);assert.deepEqual(Array.from(decoded.times,(time,i)=>[time,decoded.halfPositions[i],decoded.positions[i]]),expected.decoded);assert.deepEqual(Array.from(decoded.times,(_,i)=>stepPhase(decoded,i,-9007199254740997n,1024)),expected.phases);}
});
test('Motan trap selections retain exact endpoint, axis and out-of-range behavior',async()=>{
 for(const selection of ['velocity','accel','x','y','z','x_velocity','y_velocity','z_velocity','x_accel','y_accel','z_accel'] as TrapSelection[]){const input=motionCase(3);input.selection=selection;input.times=[0,.99,1,1.25,1.75,2,2.01,3,3.75,4,9];const expected=oracle(input);let at=0;const sampler=new MotanTrapSampler(selection,async()=>input.moves[at++]??null);const actual=[];for(const time of input.times)actual.push(await sampler.sample(time));assert.deepEqual(actual,expected.trap);}
});
test('Motan rejects inexact clocks, unbounded expansions and invalid intervals; zero markers remain valid',()=>{
 const b=motionCase(3).blocks[0];assert.throws(()=>decodeStepBlock({...b,first_clock:Number(b.first_clock)}),/exact integer/);assert.throws(()=>decodeStepBlock(b,2),/limit/);assert.throws(()=>decodeStepBlock({...b,data:[[1,3,-1]]}),/progression/);assert.throws(()=>decodeStepBlock({...b,data:[[100,65536,0]]}),/integers/);assert.throws(()=>decodeStepBlock({...b,start_position:Infinity}),/Invalid/);assert.equal(decodeStepBlock({...b,data:[[0,0,0]]}).times.length,0);assert.throws(()=>stepPhase(decodeStepBlock(b),-1,0,1024),/selection/);
});
test('Motan sampler rejects concurrency, backwards time and permanently latches failed sources',async()=>{
 let release!:(v:null)=>void;const sampler=new MotanStepSampler(()=>new Promise(resolve=>{release=resolve;}));const pending=sampler.sample(1);await assert.rejects(sampler.sample(1),/sequential/);release(null);assert.equal(await pending,0);await assert.rejects(sampler.sample(.5),/sequential/);
 let calls=0;const broken=async()=>{calls++;throw new Error('broken source');};for(const sampler of [new MotanStepSampler(broken),new MotanTrapSampler('x',broken)]){const before=calls;await assert.rejects(sampler.sample(1),/broken source/);await assert.rejects(sampler.sample(2),/broken source/);assert.equal(calls,before+1);}
});
test('Motan refuses endless stale block sources and nonfinite trap results',async()=>{
 const b=motionCase(1).blocks[0];await assert.rejects(new MotanStepSampler(async()=>b).sample(100),/block limit/);await assert.rejects(new MotanTrapSampler('x',async()=>[[0,0,0,0,[0,0,0],[0,0,0]]]).sample(1),/block limit/);await assert.rejects(new MotanTrapSampler('x',async()=>[[1,1,Number.MAX_VALUE,Number.MAX_VALUE,[0,0,0],[1,0,0]]]).sample(2),/finite range/);
});
test('Motan decreasing intervals and trailing set-position markers match original integer-clock expansion',async()=>{
 const input=motionCase(3),b=input.blocks[0];b.data=[[100,3,-2],[80,-2,7],[0,0,0]];b.last_clock=BigInt(b.first_clock)+1000n;input.blocks=[b];input.times=[0,1,1.00001,1.1,1.2,1.5,1.8,2];const expected=oracle(input),decoded=decodeStepBlock(b);assert.deepEqual(Array.from(decoded.times,(time,i)=>[time,decoded.halfPositions[i],decoded.positions[i]]),expected.decoded);let at=0;const sampler=new MotanStepSampler(async()=>input.blocks[at++]??null);const values=[];for(const time of input.times)values.push(await sampler.sample(time));assert.deepEqual(values,expected.step);
});
