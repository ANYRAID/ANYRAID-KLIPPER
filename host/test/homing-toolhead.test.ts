import {test} from 'node:test';
import assert from 'node:assert/strict';
import {homingToolheadPositions} from '../src/homing/toolhead-position.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import type {LinearConfig} from '../src/kinematics/linear.ts';
function offset(oid:number,start:bigint,trigger:bigint,halt:bigint){return {member:0,oid,start,trigger,halt,triggerOffset:trigger-start,haltOffset:halt-start,overshoot:halt-trigger};}
function linear(kind:LinearConfig['kind']){return new LinearKinematics({kind,ranges:[[0,300],[0,300],[0,300]],maxVelocity:100,maxAccel:1000,maxZVelocity:50,maxZAccel:500});}
const actuators=[{id:'a',member:0,oid:1,commanded:20,stepDistance:.01},{id:'b',member:0,oid:2,commanded:10,stepDistance:.01},{id:'c',commanded:5,stepDistance:.01}];
test('probe and home distinguish full displacement from overshoot on coupled CoreXY axes',()=>{
 const k=linear('corexy'),calculate=(p:ReadonlyMap<string,number>)=>k.calcPosition(['a','b','c'].map(id=>p.get(id)!)),offsets=[offset(1,0n,100n,103n),offset(2,0n,-100n,-99n)];
 const probe=homingToolheadPositions({mode:'probe',actuators,offsets,reference:[15,5,5,42,7],calculate});assert.deepEqual(probe.trigger,[15,6,5,42,7]);assert.deepEqual(probe.halt,[15.02,6.010000000000001,5,42,7]);
 const home=homingToolheadPositions({mode:'home',actuators,offsets,reference:[15,5,5,42],calculate});assert.deepEqual(home.trigger,[15,5,5,42]);assert(Math.abs(home.halt[0]-15.02)<1e-12);assert(Math.abs(home.halt[1]-5.01)<1e-12);
 assert.equal(k.status.homedAxes,'');assert(Object.isFrozen(probe.halt));assert.equal(actuators[0].commanded,20);
});
test('CoreXZ and unspecified axes retain toolhead tail and reference fallback',()=>{
 const k=linear('corexz'),r=homingToolheadPositions({mode:'probe',actuators,offsets:[offset(1,100n,102n,105n),offset(2,0n,0n,0n)],reference:[0,3,0,12],calculate:p=>{const xyz=k.calcPosition(['a','b','c'].map(id=>p.get(id)!));return [xyz[0],null,xyz[2]];}});
 assert.deepEqual(r.trigger,[12.51,3,7.51,12]);assert(Math.abs(r.halt[0]-12.525)<1e-12);assert.equal(r.halt[1],3);
});
test('large absolute counters are subtracted before binary64 conversion',()=>{
 const start=1n<<60n,r=homingToolheadPositions({mode:'probe',actuators:[actuators[0]],offsets:[offset(1,start,start+3n,start+4n)],reference:[20,0,0],calculate:p=>[p.get('a')!,null,null]});assert.equal(r.trigger[0],20.03);assert.equal(r.halt[0],20.04);
});
test('zero overshoot preserves the exact target without inverse-kinematics roundtrip',()=>{
 const r=homingToolheadPositions({mode:'home',actuators:[actuators[0]],offsets:[offset(1,0n,100n,100n)],reference:[1,2,3,4],calculate:()=>{assert.fail('unnecessary inverse');}});assert.strictEqual(r.trigger,r.halt);assert.deepEqual(r.halt,[1,2,3,4]);
});
test('coverage, malformed offsets, precision loss and invalid kinematic results reject',()=>{
 const base={mode:'probe' as const,actuators:[actuators[0]],offsets:[offset(1,0n,1n,2n)],reference:[0,0,0],calculate:(p:ReadonlyMap<string,number>)=>[p.get('a')!,0,0]};
 for(const invalid of [{...base,offsets:[]},{...base,offsets:[...base.offsets,...base.offsets]},{...base,offsets:[{...base.offsets[0],overshoot:5n}]},{...base,actuators:[{...actuators[0],commanded:1e20}]},{...base,offsets:[offset(1,0n,1n<<54n,1n<<54n)]},{...base,calculate:()=>[NaN,0,0]}])assert.throws(()=>homingToolheadPositions(invalid));
});
import {HomingRecovery} from '../src/homing/recovery.ts';
import {homingPositionOffsets} from '../src/homing/position-offsets.ts';
import {StepHistory} from '../src/motion/step-history.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
test('trigger history and overshoot reconstruct the actual recovery queue origin',async()=>{
 const f=await recoveryFixture(1);let motion:Awaited<ReturnType<HomingRecovery['recover']>>['motion']|undefined;
 try{
  const hit=f.options.sampling.reqClock,history=new StepHistory(hit-21n,100n);history.append({history:new BigInt64Array([hit-20n,hit,100n,3n,10n,0n]),position:103n},hit);f.fs[0].setStepperPosition(1,105);
  const clockLocation=f.options.locate;f.options.locate=result=>{
   const offsets=homingPositionOffsets(result,[{member:0,oid:1,history}],[result.hitClock!]);
   const coords=homingToolheadPositions({mode:'home',actuators:[{id:'s0',member:0,oid:1,commanded:10,stepDistance:.01}],offsets,reference:[10,0,0,99],calculate:p=>[p.get('s0')!,null,null]});
   assert.deepEqual(coords.trigger,[10,0,0,99]);assert.deepEqual(coords.halt,[10.02,0,0,99]);
   return {printTime:clockLocation(result).printTime,queues:[{id:'xyz',position:coords.halt.slice(0,3) as [number,number,number]}]};
  };
  motion=(await new HomingRecovery(f.options).recover(new AbortController().signal)).motion;
  assert.equal(motion.bindings[0].stepper.commandedPosition,10.02);assert.equal(motion.bindings[0].stepper.flush().position,105n);assert.equal(f.stops,0);
 }finally{motion?.dispose();await f.close();}
});
test('independent groups may use logical member indices through 127 without losing step precision',()=>{
 const offset={member:127,oid:1,start:0n,trigger:10n,halt:11n,triggerOffset:10n,haltOffset:11n,overshoot:1n};
 const options={mode:'home' as const,reference:[10,0,0,7],actuators:[{id:'x',member:127,oid:1,commanded:10,stepDistance:.01}],offsets:[offset],calculate:(p:ReadonlyMap<string,number>)=>[p.get('x')!,0,0]};
 assert.equal(homingToolheadPositions(options).halt[0],10.01);assert.throws(()=>homingToolheadPositions({...options,offsets:[{...offset,member:128}]}));
});
