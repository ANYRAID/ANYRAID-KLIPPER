import test from 'node:test';
import assert from 'node:assert/strict';
import {compileConfiguredHoming} from '../src/config/homing.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture,batchReader} from './helpers/configured-steppers.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
const reader=(first='^!PA4',second='PA5')=>new ConfigurationReader(new ConfigurationSource('/endstops.cfg',{x:{endstop_pin:first},y:{endstop_pin:second}},[]),null);
test('homing allocates after existing stepper owners with per-MCU IDs and explicit primary',()=>{
 const f=stepperBatchFixture();compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x'}]);
 const [p]=compileConfiguredHoming(reader(),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'aux'},{mcu:'mcu'}]}]);
 assert.equal(p.endstop.oid,1);assert.deepEqual(p.triggers.map(t=>t.protocol.oid),[0,2]);assert.equal(p.primary,1);assert.equal(p.mcu,'mcu');assert.equal(p.pin,f.pins.claimedPins[2]);assert.equal(p.pin.pullup,1);assert.equal(p.pin.invert,1);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,3);assert.equal(mcuOids(f.pins).snapshot('aux').oidCount,1);
 const sampling=p.endstop.home({printTime:1,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:p.triggers[p.primary].protocol.oid},t=>BigInt(Math.round(t*1e6))),wire=f.dictionary.parseFrame(encodeFrame(0,sampling.payload))[0];assert.equal(wire.parameters.pin_value,0);assert.equal(wire.parameters.sample_ticks,15);assert.equal(wire.parameters.trsync_oid,2);
 assert(Object.isFrozen(p.endstop)&&Object.isFrozen(p.triggers[0].protocol));assert.throws(()=>f.pins.lookup('PA4'),/used multiple times|exclusively/);
});
test('board aliases and pull-down retain exact endstop configuration semantics',()=>{
 const f=stepperBatchFixture();f.pins.resolver('mcu').alias('LIMIT','PA4');const [p]=compileConfiguredHoming(reader('~LIMIT'),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'mcu'}]}]);assert.deepEqual(p.endstop.commands,['config_endstop oid=0 pin=PA4 pull_up=-1']);assert.equal(p.pin.pullup,-1);assert.equal(p.endstop.decode({name:'endstop_state',parameters:{oid:0,homing:0,pin_value:1,next_clock:123}})?.triggered,true);
});
test('a later reserved pin or duplicate physical alias rolls back pins and every MCU OID',()=>{
 for(const mode of ['reserved','alias']){
  const f=stepperBatchFixture();if(mode==='reserved')f.pins.resolver('mcu').reserve('PA5','machine');const requests=[{section:'x',triggers:[{mcu:'mcu'},{mcu:'aux'}]},{section:'y',triggers:[{mcu:'mcu'}]}];
  assert.throws(()=>compileConfiguredHoming(reader('PA3',mode==='alias'?'PA3_ALIAS':'PA5'),f.pins,f.mcus,requests),/reserved|used multiple times/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);assert.equal(mcuOids(f.pins).snapshot('aux').oidCount,0);
  assert.equal(compileConfiguredHoming(reader('PA3','PA6'),f.pins,f.mcus,requests)[0].endstop.oid,0);
 }
});
test('firmware reservations apply to GPIO aliases and existing output owners remain intact',()=>{
 const f=stepperBatchFixture(true);assert.throws(()=>compileConfiguredHoming(reader('PA3_ALIAS'),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'mcu'}]}]),/reserved/);assert.equal(f.pins.claimedPins.length,0);
 const g=stepperBatchFixture(),owner=g.pins.lookup('PA4',{shareType:'output'});g.pins.allowMultiUse('PA4');assert.throws(()=>compileConfiguredHoming(reader(),g.pins,g.mcus,[{section:'x',triggers:[{mcu:'mcu'}]}]),/used multiple times/);assert.deepEqual(g.pins.claimedPins,[owner]);assert.equal(mcuOids(g.pins).snapshot('mcu').oidCount,0);
});
test('missing primary, duplicate members, OID collisions and wrong MCU identity fail before claims',()=>{
 for(const triggers of [[],[{mcu:'aux'}],[{mcu:'mcu'},{mcu:'mcu'}],[{mcu:'mcu',oid:0}]]){const f=stepperBatchFixture();assert.throws(()=>compileConfiguredHoming(reader(),f.pins,f.mcus,[{section:'x',oid:0,triggers}]));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);}
 const f=stepperBatchFixture();f.mcus.set('aux',{chip:{},dictionary:f.dictionary});assert.throws(()=>compileConfiguredHoming(reader(),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'mcu'},{mcu:'aux'}]}]),/ownership/);assert.equal(f.pins.claimedPins.length,0);
});
test('sealed MCU allocation rejects a new homing group without acquiring its pin',()=>{
 const f=stepperBatchFixture();mcuOids(f.pins).finalize('mcu');assert.throws(()=>compileConfiguredHoming(reader(),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'mcu'}]}]),/finalized/);assert.equal(f.pins.claimedPins.length,0);
});
test('compiled endstop and trigger plans perform exact new and reused configuration handshakes',async()=>{
 const {configureMCU}=await import('../src/protocol/mcu-config.ts'),{crc32}=await import('node:zlib'),f=stepperBatchFixture(),[p]=compileConfiguredHoming(reader(),f.pins,f.mcus,[{section:'x',triggers:[{mcu:'mcu'}]}]),oidCount=mcuOids(f.pins).finalize('mcu').oidCount,commands=[...p.endstop.commands,...p.triggers[0].protocol.commands],restart=[...p.triggers[0].protocol.restart,...p.endstop.restart],full=[`allocate_oids count=${oidCount}`,...commands],crc=crc32(Buffer.from(full.join('\n')));
 for(const reused of [false,true]){const sent:Uint8Array[]=[];let queries=0;const result=await configureMCU(f.dictionary,{async query(){return {message:{name:'config',parameters:{is_config:reused||queries++>0?1:0,crc,is_shutdown:0,move_count:512}},sentTime:1,receiveTime:1};},async send(payload){sent.push(payload.slice());},async stop(){assert.fail('valid homing configuration stopped');}},{oidCount,commands,restart},new AbortController().signal);assert.equal(result.reused,reused);assert.deepEqual(sent,(reused?restart:[...full,`finalize_config crc=${crc}`]).map(c=>f.dictionary.encodeCommand(c)));}
});
test('virtual TMC DIAG pins retain physical polarity, ownership and driver identity',()=>{
 for(const model of ['tmc2209','tmc2130','tmc5160'])for(const diag of [0,1]){
  const f=stepperBatchFixture(),option=model==='tmc2209'?'diag_pin':`diag${diag}_pin`;
  const r=new ConfigurationReader(new ConfigurationSource('/endstops.cfg',{stepper_x:{endstop_pin:model+'_stepper_x:virtual_endstop'},[model+' stepper_x']:{[option]:'^!PA4'}},[]),null);
  const [p]=compileConfiguredHoming(r,f.pins,f.mcus,[{section:'stepper_x',triggers:[{mcu:'mcu'}]}]);assert.deepEqual(p.sensorless,{section:model+' stepper_x',diag:model==='tmc2209'?undefined:diag});assert.equal(p.pin.invert,1);assert.equal(p.pin.pullup,1);assert.equal(p.pin.pin,'PA4');
 }
});
test('invalid virtual pins and reserved physical DIAG fail without claims',()=>{
 for(const virtual of ['^tmc2209_stepper_x:virtual_endstop','!tmc2209_stepper_x:virtual_endstop','tmc2208_stepper_x:virtual_endstop','tmc2209_stepper_x:other','tmc2209_missing:virtual_endstop']){
  const f=stepperBatchFixture(),r=new ConfigurationReader(new ConfigurationSource('/endstops.cfg',{stepper_x:{endstop_pin:virtual},'tmc2209 stepper_x':{diag_pin:'PA4'}},[]),null);
  assert.throws(()=>compileConfiguredHoming(r,f.pins,f.mcus,[{section:'stepper_x',triggers:[{mcu:'mcu'}]}]));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 }
 const f=stepperBatchFixture(true),r=new ConfigurationReader(new ConfigurationSource('/endstops.cfg',{stepper_x:{endstop_pin:'tmc2209_stepper_x:virtual_endstop'},'tmc2209 stepper_x':{diag_pin:'PA3_ALIAS'}},[]),null);
 assert.throws(()=>compileConfiguredHoming(r,f.pins,f.mcus,[{section:'stepper_x',triggers:[{mcu:'mcu'}]}]),/reserved/);assert.equal(f.pins.claimedPins.length,0);
});
