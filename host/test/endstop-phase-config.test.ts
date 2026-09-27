import test from 'node:test';
import assert from 'node:assert/strict';
import {linearMotionReader} from './helpers/linear-motion-config.ts';
import {configureEndstopPhases} from '../src/config/endstop-phase.ts';
import {TmcPhaseState} from '../src/drivers/tmc-phase.ts';
const steppers=[{section:'stepper_x',emitter:'x'}];
const reader=()=>linearMotionReader({stepper_x:{rotation_distance:'32',microsteps:'16'},'endstop_phase stepper_x':{trigger_phase:'7/128',endstop_align_zero:'true',endstop_accuracy:'.04'}});
test('configured phase owns physical step distance and live initialized TMC phase',()=>{
 const phase=new TmcPhaseState(16,false),[owner]=configureEndstopPhases(reader(),steppers,[{section:'tmc2209 stepper_x',phase}]);
 assert.equal(owner.id,'x');assert.equal(owner.alignment.status.triggerPhase,4);assert.equal(owner.alignment.status.accuracy,2);assert.equal(owner.offset(),null);
 phase.synchronize(0,0n);assert.equal(owner.offset(),0);phase.retire();assert.equal(owner.offset(),null);
 const [gpio]=configureEndstopPhases(reader(),steppers,[]);assert.equal(gpio.offset(),0);
});
test('phase config rejects unknown motors, malformed ratios and uninitialized driver owners',()=>{
 assert.throws(()=>configureEndstopPhases(reader(),[],[]),/Unknown/);
 const r=linearMotionReader({stepper_x:{rotation_distance:'32',microsteps:'16'},'endstop_phase stepper_x':{trigger_phase:'1/0'}});assert.throws(()=>configureEndstopPhases(r,steppers,[]));
 const missing=linearMotionReader({stepper_x:{rotation_distance:'32',microsteps:'16'},'endstop_phase stepper_x':{},'tmc2209 stepper_x':{}});assert.throws(()=>configureEndstopPhases(missing,steppers,[]),/not initialized/);
});
test('unconfigured TMC rails collect statistics without enabling correction',()=>{
 const phase=new TmcPhaseState(16,false),r=linearMotionReader({stepper_x:{rotation_distance:'32',microsteps:'16'}}),owners=configureEndstopPhases(r,steppers,[{section:'tmc2209 stepper_x',phase}]);assert.equal(owners.length,1);assert.equal(owners[0].name,'stepper_x');assert.equal(owners[0].statsOnly,true);assert.equal(owners[0].alignment.status.triggerPhase,null);
});
