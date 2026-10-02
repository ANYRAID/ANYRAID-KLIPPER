import test from 'node:test';
import assert from 'node:assert/strict';
import {carriagePosition,carriageOrder,carriageHomingOrder,carriageSafeDistance,dualCarriageRange,planCarriageMode,type CarriagePair,type CarriageRail} from '../src/kinematics/dual-carriage.ts';
const rails:readonly [CarriageRail,CarriageRail]=[{minimum:0,maximum:200,endstop:0,positiveDirection:false},{minimum:0,maximum:220,endstop:220,positiveDirection:true}];
const primary:CarriagePair=[{mode:'PRIMARY',scale:1,offset:0},{mode:'INACTIVE',scale:0,offset:180}];
test('primary switches rebase the logical coordinate without moving either carriage',()=>{
 const switched=planCarriageMode(primary,40,1,'PRIMARY',true);assert.equal(switched.position,180);assert.deepEqual(switched.carriages.map(t=>carriagePosition(t,switched.position)),[40,180]);assert.deepEqual(primary,[{mode:'PRIMARY',scale:1,offset:0},{mode:'INACTIVE',scale:0,offset:180}]);
 const restored=planCarriageMode(switched.carriages,switched.position,0,'PRIMARY',true);assert.equal(restored.position,40);assert.deepEqual(restored.carriages.map(t=>carriagePosition(t,restored.position)),[40,180]);assert.deepEqual(dualCarriageRange(rails,switched.carriages,10),[50,220]);
});
test('primary, copy and mirror ranges retain rail bounds and half-distance collision limit',()=>{
 assert.deepEqual(dualCarriageRange(rails,primary,10),[0,170]);
 const copy=planCarriageMode(primary,40,1,'COPY',true);assert.deepEqual(copy.carriages.map(t=>carriagePosition(t,40)),[40,180]);assert.deepEqual(dualCarriageRange(rails,copy.carriages,10),[0,80]);
 const mirror=planCarriageMode(primary,40,1,'MIRROR',true);assert.deepEqual(dualCarriageRange(rails,mirror.carriages,10),[0,105]);assert.deepEqual(mirror.carriages.map(t=>carriagePosition(t,105)),[105,115]);
 assert.equal(dualCarriageRange(rails,[primary[0],{mode:'COPY',scale:1,offset:5}],10),null);
 assert.equal(dualCarriageRange(rails,[primary[0],{mode:'INACTIVE',scale:0,offset:-20}],10),null);
});
test('order and defaults follow endstop geometry, including same-direction homing',()=>{
 assert.equal(carriageOrder(rails),-1);assert.deepEqual(carriageHomingOrder(rails),[0,1]);assert.equal(carriageSafeDistance(rails),0);
 const same:readonly [CarriageRail,CarriageRail]=[rails[0],{...rails[1],endstop:10,positiveDirection:false}];assert.deepEqual(carriageHomingOrder(same),[0,1]);assert.deepEqual(carriageHomingOrder([same[1],same[0]]),[1,0]);assert.throws(()=>carriageOrder([rails[0],rails[0]]),/Ambiguous/);
});
test('mode authority and nonfinite geometry reject before publication',()=>{
 assert.throws(()=>planCarriageMode(primary,40,0,'INACTIVE',true),/only active/);assert.throws(()=>planCarriageMode(primary,40,0,'COPY',true),/another primary/);assert.throws(()=>planCarriageMode(primary,40,1,'MIRROR',false),/homed/);assert.throws(()=>planCarriageMode(primary,Infinity,1,'PRIMARY',true));assert.throws(()=>dualCarriageRange(rails,primary,-1));assert.throws(()=>dualCarriageRange(rails,[primary[0],{mode:'COPY',scale:0,offset:0}]));
});
test('sampled admissible intervals respect both physical rails and the configured gap',()=>{
 for(let i=0;i<1000;i++){const position=10+i%50,parked=100+i%80,initial:CarriagePair=[primary[0],{mode:'INACTIVE',scale:0,offset:parked}];
 for(const mode of ['PRIMARY','COPY','MIRROR'] as const){const state=planCarriageMode(initial,position,1,mode,true),range=dualCarriageRange(rails,state.carriages,8);assert(range);
 for(const x of [range[0],range[0]+(range[1]-range[0])/2,range[1]]){const physical=state.carriages.map(t=>carriagePosition(t,x));for(let j=0;j<2;j++)assert(physical[j]>=rails[j].minimum&&physical[j]<=rails[j].maximum);assert(physical[1]-physical[0]>=8);}
 }}
});
test('feasible ranges match frozen legacy Python references without tolerance',async()=>{
 const {readFile}=await import('node:fs/promises');const reference=JSON.parse(await readFile(new URL('./fixtures/dual-carriage-reference.json',import.meta.url),'utf8'));
 assert.equal(reference.cases.length,24);for(const c of reference.cases)assert.deepEqual(dualCarriageRange(c.rails,c.carriages,c.safeDistance),c.expected);
});
