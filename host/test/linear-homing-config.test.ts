import test from 'node:test';
import assert from 'node:assert/strict';
import {initialLinearFixture} from './helpers/initial-linear.ts';
import {compileLinearHoming,type ConfiguredLinearHoming} from '../src/config/linear-homing.ts';
test('configured homing compiles split stop groups with exact protocols and immutable ownership',async()=>{
 const f=await initialLinearFixture(true);try{
  const request:ConfiguredLinearHoming=structuredClone(f.configuredSettings);request.homing=[[{section:'stepper_x',emitters:['x','z']},{section:'stepper_y',emitters:['y','e'],expireTimeout:.4}],request.homing[1],request.homing[2]];
  const result=compileLinearHoming(f.hardware.plan,f.initial.generation,request),first=result.groupsByAxis[0];
  assert.deepEqual(result.endstopNames[0],['stepper_x','stepper_y']);assert.equal(first[0].members[0].physicalMember,0);assert.equal(f.hardware.plan.steppers[0].physicalMember,1);assert.equal(first[1].expireTimeout,.4);
  assert.strictEqual(first[0].endstop,f.hardware.plan.homing[0].endstop);assert.strictEqual(first[1].members[0].trigger,f.hardware.plan.homing[1].triggers[0].protocol);assert.deepEqual(first[1].members[0].emitters,['y','e']);
  (request.homing[0][0].emitters as string[])[0]='changed';assert.deepEqual(first[0].members[0].emitters,['x','z']);assert(Object.isFrozen(first[0].members[0].emitters));assert.deepEqual(f.stops,[0,0]);assert.equal(f.firmware[0].motion.length,0);
 }finally{await f.hardware.close();await f.close();}
});
test('configured homing rejects invalid coverage before claiming the linear port',async()=>{
 const f=await initialLinearFixture();try{
  for(const entries of [[],[{section:'missing',emitters:['x','y','z','e']}],[{section:'stepper_x',emitters:['x','y','z']}],[{section:'stepper_x',emitters:['x','y','z','e','x']}],[{section:'stepper_x',emitters:['x','y','z','e'],expireTimeout:NaN}]]){
   const request=structuredClone(f.configuredSettings);request.homing=[entries,request.homing[1],request.homing[2]];assert.throws(()=>f.initial.createLinearPort(f.reader,request),/homing/);assert.deepEqual(f.stops,[0,0]);
  }
  const request=structuredClone(f.configuredSettings);request.kinematicIds=['x','y','e'];assert.throws(()=>f.initial.createLinearPort(f.reader,request),/representatives/);
  const missing={...f.hardware.plan,homing:f.hardware.plan.homing.map((h,i)=>i? h:{...h,triggers:[]})};assert.throws(()=>compileLinearHoming(missing,f.initial.generation,f.configuredSettings),/trigger coverage/);
  const gpioOnly={...f.hardware.plan,homing:f.hardware.plan.homing.map((h,i)=>i?h:{...h,mcu:'aux'})};assert.throws(()=>compileLinearHoming(gpioOnly,f.initial.generation,f.configuredSettings),/kinematic motor/);
  f.initial.createLinearPort(f.reader,f.configuredSettings);assert.equal(f.hardware.status.state,'ready');
 }finally{await f.hardware.close();await f.close();}
});
