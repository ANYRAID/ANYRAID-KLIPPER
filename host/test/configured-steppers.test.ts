import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {stepperBatchFixture,batchReader} from './helpers/configured-steppers.ts';
const requests=[{section:'stepper_x',oid:1},{section:'stepper_y',oid:2}];
test('whole stepper batch resolves aliases and compiles before publishing pin claims',()=>{
 const f=stepperBatchFixture(),plans=compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests);assert.equal(plans.length,2);assert.equal(f.pins.claimedPins.length,4);assert.match(plans[0].config,/step_pin=PA0 dir_pin=PA1 invert_step=1/);assert.equal(plans[0].compressor.invertDirection,true);assert.equal(plans[0].stepDistance,.0125);assert.equal(plans[0].mcu,'mcu');assert.equal(plans[0].step,f.pins.claimedPins[0]);assert.equal(plans[0].direction,f.pins.claimedPins[1]);
});
test('later numerical error leaves no claims and the corrected whole batch can retry',()=>{
 const f=stepperBatchFixture();assert.throws(()=>compileConfiguredSteppers(batchReader({microsteps:'0'}),f.pins,f.mcus,requests));assert.equal(f.pins.claimedPins.length,0);assert.equal(compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests).length,2);
});
test('firmware GPIO aliases cannot duplicate a step pin within a batch',()=>{
 const f=stepperBatchFixture();assert.throws(()=>compileConfiguredSteppers(batchReader({step_pin:'PA0_ALIAS'}),f.pins,f.mcus,requests),/physical stepper pin/);assert.equal(f.pins.claimedPins.length,0);
});
test('physical GPIO already held by a non-stepper owner cannot be reused through another spelling',()=>{
 const f=stepperBatchFixture(),owner=f.pins.lookup('PA0_ALIAS',{shareType:'enable'});f.pins.allowMultiUse('PA0_ALIAS');assert.throws(()=>compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests),/physical stepper pin/);assert.deepEqual(f.pins.claimedPins,[owner]);
});
test('reserved firmware pins and mismatched step/dir MCUs fail without partial acquisition',()=>{
 for(const [reserved,values] of [[true,{}],[false,{dir_pin:'aux:PA3'}]] as const){const f=stepperBatchFixture(reserved);assert.throws(()=>compileConfiguredSteppers(batchReader(values),f.pins,f.mcus,requests),/reserved|ownership/);assert.equal(f.pins.claimedPins.length,0);}
});
test('OID uniqueness spans accepted batches but permits equal OIDs on separate MCUs',()=>{
 const f=stepperBatchFixture();compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[requests[0]]);assert.throws(()=>compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_y',oid:1}]),/OID/);assert.equal(f.pins.claimedPins.length,2);
 const plans=compileConfiguredSteppers(batchReader({step_pin:'aux:PA0',dir_pin:'aux:PA1'}),f.pins,f.mcus,[{section:'stepper_y',oid:1}]);assert.equal(plans[0].mcu,'aux');assert.equal(f.pins.claimedPins.length,4);
});
test('failed pin batch keeps prior claims and never publishes its new OID reservation',()=>{
 const f=stepperBatchFixture();f.pins.resolver('mcu').reserve('PA3','machine');assert.throws(()=>compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests),/reserved/);assert.equal(f.pins.claimedPins.length,0);assert.equal(compileConfiguredSteppers(batchReader({dir_pin:'PA4'}),f.pins,f.mcus,requests).length,2);
});
test('compiled batch completes MCU configuration handshake with exact resolved command bytes',async()=>{
 const {configureMCU}=await import('../src/protocol/mcu-config.ts'),{crc32}=await import('node:zlib'),f=stepperBatchFixture(),plans=compileConfiguredSteppers(batchReader(),f.pins,f.mcus,requests),commands=['allocate_oids count=3',...plans.map(p=>p.config)],crc=crc32(Buffer.from(commands.join('\n'))),sent:Uint8Array[]=[];let queries=0;
 const configured=await configureMCU(f.dictionary,{async query(){return {message:{name:'config',parameters:{is_config:queries++?1:0,crc,is_shutdown:0,move_count:512}},sentTime:1,receiveTime:1};},async send(payload){sent.push(payload.slice());},async stop(){assert.fail('valid compiled plan stopped');}},{oidCount:3,commands:plans.map(p=>p.config),restart:plans.map(p=>p.restart),pins:f.pins.resolver('mcu')},new AbortController().signal);
 assert.equal(configured.crc,crc);assert.equal(configured.moveSlots,512);assert.equal(queries,2);assert.deepEqual(sent,[...commands,`finalize_config crc=${crc}`].map(c=>f.dictionary.encodeCommand(c)));
});
test('firmware and machine reserved pins cannot be reached through a firmware enumeration alias',()=>{
 for(const firmware of [false,true]){const f=stepperBatchFixture(firmware);if(!firmware)f.pins.resolver('mcu').reserve('PA3','machine');assert.throws(()=>compileConfiguredSteppers(batchReader({dir_pin:'PA3_ALIAS'}),f.pins,f.mcus,requests),/reserved physical/);assert.equal(f.pins.claimedPins.length,0);}
});
