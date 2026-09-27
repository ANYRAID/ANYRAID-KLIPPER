import test from 'node:test';
import assert from 'node:assert/strict';
import {FilamentMotionState} from '../src/inputs/filament-motion.ts';
test('encoder edges grant detection travel, threshold equality detects runout, retraction does not reset it',()=>{
 const sensor=new FilamentMotionState(7);assert.throws(()=>sensor.check(0,0),/baseline/);sensor.pulse(0,100);
 assert.equal(sensor.check(1,106.999),true);assert.equal(sensor.check(2,107),false);
 assert.equal(sensor.check(3,99),true);assert.equal(sensor.check(4,107),false);
 sensor.pulse(5,107);assert.equal(sensor.check(6,113),true);assert.equal(sensor.check(7,114),false);
});
test('invalid time and unrepresentable thresholds do not mutate accepted state',()=>{
 for(const length of [0,-1,NaN,Infinity])assert.throws(()=>new FilamentMotionState(length));
 const sensor=new FilamentMotionState(.001);sensor.pulse(10,1);const saved=sensor.status;
 for(const [time,pos] of [[9,1],[NaN,1],[11,Infinity],[11,1e30]])assert.throws(()=>sensor.pulse(time,pos));assert.deepEqual(sensor.status,saved);
 assert.throws(()=>sensor.check(9,1));assert.deepEqual(sensor.status,saved);assert.equal(sensor.check(10,1),true);
});
