import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredMotorEnables} from '../src/config/motor-enable.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import type {MCUGroup} from '../src/runtime/mcu-group.ts';
import {stepperBatchFixture} from './helpers/configured-steppers.ts';
function motorConfigFixture(){
 const f=stepperBatchFixture(),session={dictionary:f.dictionary},group={session:()=>session} as unknown as MCUGroup;
 const reader=(x='!PA3',y='!PA3_ALIAS')=>new ConfigurationReader(new ConfigurationSource('/motors.cfg',{stepper_x:{step_pin:'PA0',dir_pin:'PA1',rotation_distance:'40',microsteps:'16',enable_pin:x},stepper_y:{enable_pin:y}},[]),null);
 const requests=['x','y'].map(id=>({section:`stepper_${id}`,emitter:id,mcu:'mcu',leadTime:.001,calibration:{offset:0,frequency:1e6}}));
 return {...f,group,reader,requests};
}
test('shared physical enable aliases use one exclusive GPIO and one global OID after stepper',()=>{
 const f=motorConfigFixture();compileConfiguredSteppers(f.reader(),f.pins,f.mcus,[{section:'stepper_x'}]);
 const plans=compileConfiguredMotorEnables(f.reader(),f.pins,f.group,f.requests).lines;assert.equal(plans.length,1);assert.equal(plans[0].config.oid,1);assert.deepEqual(plans[0].emitters,['x','y']);assert.equal(plans[0].config.reservedMoves,1);assert.match(plans[0].config.config,/pin=PA3 value=1 default_value=1 max_duration=0/);assert.equal(f.pins.claimedPins.length,3);
 assert.equal(mcuOids(f.pins).finalize('mcu').oidCount,2);assert.throws(()=>f.pins.lookup('PA3_ALIAS'),/used multiple times|exclusively/);
});
test('conflicting shared polarity and timing fail before any resource is published',()=>{
 for(const mode of ['polarity','lead','clock']){const f=motorConfigFixture();if(mode==='lead')f.requests[1].leadTime=.002;if(mode==='clock')f.requests[1].calibration.offset=1;
  assert.throws(()=>compileConfiguredMotorEnables(f.reader('!PA3',mode==='polarity'?'PA3_ALIAS':'!PA3_ALIAS'),f.pins,f.group,f.requests),/polarity or timing/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 }
});
test('a later reserved line rolls back all enable pins and OIDs and permits correction',()=>{
 const f=motorConfigFixture();f.pins.resolver('mcu').reserve('PA4','machine');
 assert.throws(()=>compileConfiguredMotorEnables(f.reader('PA3','PA4'),f.pins,f.group,f.requests),/reserved/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 const plans=compileConfiguredMotorEnables(f.reader('PA3','PA5'),f.pins,f.group,f.requests).lines;assert.deepEqual(plans.map(p=>p.config.oid),[0,1]);assert.equal(f.pins.claimedPins.length,2);
});
test('enable plans cannot steal step GPIOs and failed claims do not consume OIDs',()=>{
 const f=motorConfigFixture();compileConfiguredSteppers(f.reader(),f.pins,f.mcus,[{section:'stepper_x'}]);
 assert.throws(()=>compileConfiguredMotorEnables(f.reader('PA0','PA3'),f.pins,f.group,f.requests),/used multiple times|exclusively/);assert.equal(f.pins.claimedPins.length,2);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,1);
 assert.equal(compileConfiguredMotorEnables(f.reader(),f.pins,f.group,f.requests).lines[0].config.oid,1);
});
test('board aliases resolve before encoding and shared enable owners cannot be extended later',()=>{
 const f=motorConfigFixture();f.pins.resolver('mcu').alias('ENABLE','PA3');const plans=compileConfiguredMotorEnables(f.reader('!ENABLE','!PA3_ALIAS'),f.pins,f.group,f.requests).lines;assert.equal(plans.length,1);assert.match(plans[0].config.config,/pin=PA3 /);
 assert.throws(()=>compileConfiguredMotorEnables(f.reader(),f.pins,f.group,f.requests),/Duplicate/);assert.equal(f.pins.claimedPins.length,1);
});
test('wrong MCU, duplicate emitters and invalid timing fail while missing enable pins become always-on',()=>{
 const f=motorConfigFixture();f.requests[1].mcu='aux';assert.throws(()=>compileConfiguredMotorEnables(f.reader(),f.pins,f.group,f.requests),/differs from motor MCU/);f.requests[1].mcu='mcu';
 assert.throws(()=>compileConfiguredMotorEnables(f.reader(),f.pins,f.group,[f.requests[0],{...f.requests[1],emitter:'x'}]),/batch/);
 assert.throws(()=>compileConfiguredMotorEnables(f.reader(),f.pins,f.group,[{...f.requests[0],leadTime:NaN}]),/timing/);
 const missing=new ConfigurationReader(new ConfigurationSource('/missing.cfg',{stepper_x:{}},[]),null);assert.equal(compileConfiguredMotorEnables(missing,f.pins,f.group,[f.requests[0]]).alwaysOn.length,1);
 assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
});
