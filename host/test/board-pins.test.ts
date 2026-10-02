import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {PrinterPins} from '../src/protocol/pins.ts';
import {applyConfiguredBoardPins} from '../src/config/board-pins.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {hardwareFixture,hardwareReader,hardwareLayout,hardwareClocks} from './helpers/configured-hardware.ts';
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/board.cfg',s,[]),null);
test('malformed alias pairs cannot publish aliases after empty fields are discarded',()=>{
 for(const malformed of ['STEP==PA0','=STEP=PA0','STEP=PA0=','STEP=','=PA0','STEP= =PA0']){
  const pins=new PrinterPins<object>();pins.register('mcu',{});pins.register('aux',{});
  assert.throws(()=>applyConfiguredBoardPins(reader({board_pins:{mcu:'mcu, aux',aliases:'DIR=PA1',aliases_extra:malformed}}),pins),/Malformed board alias/,malformed);
  for(const id of ['mcu','aux'])assert.deepEqual(pins.resolver(id).resolve(['c pin=DIR','c pin=STEP']),['c pin=DIR','c pin=STEP']);
 }
});
test('empty outer comma entries remain valid board configuration',()=>{
 const pins=new PrinterPins<object>();pins.register('mcu',{});
 applyConfiguredBoardPins(reader({board_pins:{aliases:', STEP = PA0, , DIR = PA1, '}}),pins);
 assert.deepEqual(pins.resolver('mcu').resolve(['c pin=STEP','c pin=DIR']),['c pin=PA0','c pin=PA1']);
});
test('board aliases support prefixed lists, multiple MCUs and logical power reservations',()=>{
 const pins=new PrinterPins<object>();pins.register('mcu',{});pins.register('aux',{});
 applyConfiguredBoardPins(reader({'board_pins':{mcu:'mcu, aux',aliases:'STEP=PA0, POWER=<5V>',aliases_extra:'DIR=PA1'},'board_pins extension':{aliases:'MOTOR=STEP'}}),pins);
 for(const id of ['mcu','aux']){assert.deepEqual(pins.resolver(id).resolve(['c pin=STEP']),['c pin=PA0']);assert.throws(()=>pins.resolver(id).resolve(['c pin=POWER']),/reserved/);assert.deepEqual(pins.resolver(id).physicalReservations({PA0:0,PA1:1}),[]);}
 assert.deepEqual(pins.resolver('mcu').clone().physicalReservations({PA0:0}),[]);
});
test('late invalid board alias leaves every MCU resolver unchanged',()=>{
 const pins=new PrinterPins<object>();pins.register('mcu',{});pins.register('aux',{});
 assert.throws(()=>applyConfiguredBoardPins(reader({board_pins:{mcu:'mcu, aux',aliases:'STEP=PA0',aliases_bad:'STEP=PA1'}}),pins),/already mapped/);
 for(const id of ['mcu','aux'])assert.deepEqual(pins.resolver(id).resolve(['c pin=STEP']),['c pin=STEP']);
});
test('logical reservation of an actual pin still blocks numeric aliases',()=>{
 const pins=new PrinterPins<object>(),chip={};pins.register('mcu',chip);applyConfiguredBoardPins(reader({board_pins:{aliases:'PA0=<debug>'}}),pins);
 assert.deepEqual(pins.resolver('mcu').physicalReservations({PA0:0,ALT:0}),[0]);assert.throws(()=>pins.lookupBatch([{description:'ALT'}],new Map([['mcu',{pins:{PA0:0,ALT:0},reserved:[0]}]])),/reserved/);
 pins.resolver('mcu').reserve('MISSING','firmware');assert.throws(()=>pins.resolver('mcu').physicalReservations({PA0:0}),/Unknown reserved physical/);
});
test('hardware assembly reads board_pins without manual layout aliases',()=>{
 const f=hardwareFixture(),base=hardwareReader(),r=reader({...base.source.original,board_pins:{aliases:'STEP=PA0, POWER=<5V>'}}),plan=compileConfiguredHardware(r,f.group,hardwareClocks(),{...hardwareLayout,boards:[]});
 assert(plan.configurations[0].plan.commands.some(c=>c.includes('step_pin=PA0 dir_pin=PA1')));assert.equal(plan.steppers[0].stepDistance,.0125);assert.deepEqual(plan.configurations.map(c=>c.plan),compileConfiguredHardware(base,f.group,hardwareClocks(),hardwareLayout).configurations.map(c=>c.plan));
 const bad=reader({...base.source.original,board_pins:{aliases:'STEP=<5V>'}});assert.throws(()=>compileConfiguredHardware(bad,f.group,hardwareClocks(),{...hardwareLayout,boards:[]}),/reserved/);
});
