import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TemperatureState} from '../src/thermal/state.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {Move,motionLimits} from '../src/motion/lookahead.ts';
const config={minimum:0,maximum:300,minimumExtrude:170,smoothTime:1};
test('temperature smoothing determines extrusion permission and stale display resets',()=>{
 const s=new TemperatureState(config);s.setTarget(200);assert.equal(s.status(0).canExtrude,false);
 s.sample(.25,200);assert.equal(s.state.smoothedTemperature,50);assert.equal(s.status(.25).canExtrude,false);
 s.sample(1.25,200);assert.equal(s.status(8.25).canExtrude,true);assert.equal(s.status(8.25001).canExtrude,false);assert.equal(s.status(8.25001).temperature,0);
 s.sample(9,190);assert.equal(s.status(9).canExtrude,true);
});
test('sensor faults latch, clear target, and prevent stale hot state from permitting extrusion',()=>{
 for(const [time,temp] of [[2,NaN],[2,301],[2,-1],[1,200],[.5,200]]) {
  const s=new TemperatureState(config);s.sample(1,200);s.setTarget(200);assert.throws(()=>s.sample(time,temp));
  assert.equal(s.status(2).canExtrude,false);assert.equal(s.state.target,0);assert.throws(()=>s.setTarget(200));assert.throws(()=>s.sample(3,200));
 }
});
test('target limits allow off independently, and shutdown cannot be reversed',()=>{
 const s=new TemperatureState({...config,minimum:10});s.setTarget(300);assert.throws(()=>s.setTarget(301));assert.equal(s.state.target,300);
 s.setTarget(0);assert.equal(s.state.target,0);s.shutdown();s.setTarget(0);assert.throws(()=>s.setTarget(100));
});
test('extrusion guard consumes fresh permission at every movement admission',()=>{
 const s=new TemperatureState(config),guard=new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:.64,maxVelocity:25,maxAccel:500,maxDistance:50,instantCornerVelocity:1});
 const move=()=>new Move(motionLimits(100,1000),[0,0,0,0],[0,0,0,1],5);
 assert.throws(()=>guard.check(move(),3,s.status(0).canExtrude));s.sample(1,200);guard.check(move(),3,s.status(1).canExtrude);
 assert.throws(()=>guard.check(move(),3,s.status(9).canExtrude));s.shutdown();assert.throws(()=>guard.check(move(),3,s.status(1).canExtrude));
});
