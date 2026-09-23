import test from 'node:test';
import assert from 'node:assert/strict';
import {MCUOidRegistry,mcuOids} from '../src/protocol/mcu-oids.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {stepperBatchFixture,batchReader} from './helpers/configured-steppers.ts';
test('OID allocation reserves explicit IDs before automatic IDs and separates MCUs',()=>{
 const r=new MCUOidRegistry(),ids=r.claim([{mcu:'mcu',owner:'x'},{mcu:'mcu',owner:'fan',oid:0},{mcu:'aux',owner:'x'}],ids=>ids);
 assert.deepEqual(ids,[1,0,0]);assert(Object.isFrozen(ids));assert.equal(r.snapshot('mcu').oidCount,2);assert.equal(r.snapshot('aux').oidCount,1);
 assert.throws(()=>r.claim([{mcu:'mcu',owner:'other',oid:1}],()=>null),/Duplicate MCU OID/);
 assert.throws(()=>r.claim([{mcu:'mcu',owner:'x'}],()=>null),/owner/);
});
test('failed builders and later-MCU exhaustion roll back every reservation',()=>{
 const r=new MCUOidRegistry();r.claim(Array.from({length:255},(_,oid)=>({mcu:'full',owner:`owner${oid}`})),()=>null);
 assert.equal(r.snapshot('full').oidCount,255);
 assert.throws(()=>r.claim([{mcu:'other',owner:'first'},{mcu:'full',owner:'overflow'}],()=>assert.fail('must not build')),/capacity/);
 assert.equal(r.snapshot('other').oidCount,0);
 assert.throws(()=>r.claim([{mcu:'other',owner:'first'}],()=>{throw new Error('compile failed');}),/compile failed/);
 assert.equal(r.claim([{mcu:'other',owner:'first'}],ids=>ids[0]),0);
});
test('registry rejects reentry, invalid IDs and async results without consuming IDs',()=>{
 const r=new MCUOidRegistry(),spec=[{mcu:'mcu',owner:'x'}];
 assert.throws(()=>r.claim(spec,()=>r.claim(spec,()=>null)),/Nested/);
 // Deliberately bypass TypeScript's synchronous callback constraint.
 assert.throws(()=>r.claim(spec,(()=>Promise.resolve()) as never),/synchronous/);
 for(const oid of [-1,255,.5,NaN,Infinity])assert.throws(()=>r.claim([{...spec[0],oid}],()=>null),/Invalid MCU OID/);
 assert.equal(r.snapshot('mcu').oidCount,0);r.claim([{...spec[0],oid:254}],()=>null);const snapshot=r.snapshot('mcu');assert.equal(snapshot.oidCount,255);
 assert(Object.isFrozen(snapshot)&&Object.isFrozen(snapshot.owners)&&Object.isFrozen(snapshot.owners[0]));
 assert.equal(r.claim([{mcu:'mcu',owner:'hole'}],ids=>ids[0]),0);assert.equal(snapshot.owners.length,1);
});
test('configured steppers share OIDs with other devices and allocate independently per MCU',()=>{
 const f=stepperBatchFixture(),r=mcuOids(f.pins);assert.equal(mcuOids(f.pins),r);r.claim([{mcu:'mcu',owner:'fan',oid:0}],()=>null);
 const plans=compileConfiguredSteppers(batchReader({step_pin:'aux:PA0',dir_pin:'aux:PA1'}),f.pins,f.mcus,[{section:'stepper_x'},{section:'stepper_y'}]);
 assert.equal(plans[0].compressor.oid,1);assert.equal(plans[1].compressor.oid,0);assert.equal(r.snapshot('mcu').oidCount,2);assert.equal(r.snapshot('aux').oidCount,1);
 assert.throws(()=>r.claim([{mcu:'mcu',owner:'endstop',oid:1}],()=>null),/Duplicate/);
});
test('bad stepper plan leaves pins and automatic OIDs available for corrected configuration',()=>{
 const f=stepperBatchFixture(),r=mcuOids(f.pins),requests=[{section:'stepper_x'},{section:'stepper_y'}];
 assert.throws(()=>compileConfiguredSteppers(batchReader({microsteps:'0'}),f.pins,f.mcus,requests));assert.equal(r.snapshot('mcu').oidCount,0);assert.equal(f.pins.claimedPins.length,0);
 const plans=compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests);assert.deepEqual(plans.map(p=>p.compressor.oid),[0,1]);
});
test('external OID conflict is rejected before acquiring any configured stepper pin',()=>{
 const f=stepperBatchFixture(),r=mcuOids(f.pins);r.claim([{mcu:'mcu',owner:'heater',oid:3}],()=>null);
 assert.throws(()=>compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x',oid:3}]),/Duplicate/);assert.equal(f.pins.claimedPins.length,0);assert.equal(r.snapshot('mcu').owners.length,1);
});
test('finalization fixes the firmware object count without sealing other MCUs',()=>{
 const f=stepperBatchFixture(),r=mcuOids(f.pins);compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x'}]);
 const summary=r.finalize('mcu');assert.equal(summary.oidCount,1);assert.deepEqual(r.finalize('mcu'),summary);
 assert.throws(()=>compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_y'}]),/finalized/);assert.equal(f.pins.claimedPins.length,2);
 assert.throws(()=>r.claim([{mcu:'aux',owner:'endstop'}],()=>r.finalize('aux')),/during/);assert.equal(r.snapshot('aux').oidCount,0);
 r.claim([{mcu:'aux',owner:'endstop'}],()=>null);assert.equal(r.finalize('aux').oidCount,1);assert.equal(r.finalize('empty').oidCount,0);
 assert.throws(()=>r.claim([{mcu:'empty',owner:'late'}],()=>null),/finalized/);
});
