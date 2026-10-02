import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compileSpi,compileSoftwareSpi,spiFormats,softwareSpiFormats,legacySpiConfig} from '../src/protocol/spi-config.ts';
const chip={},pin=(name:string)=>({chip,chipName:'mcu',pin:name,invert:0 as const,pullup:0 as const});
function dictionary(config:string,software?:boolean){
 const d=new MessageDictionary();d.identify(Buffer.from(JSON.stringify({commands:{[config]:10,[spiFormats.send]:11,[spiFormats.transfer]:12,[software===undefined?spiFormats.bus:software?softwareSpiFormats.modern:softwareSpiFormats.legacy]:13},responses:{[spiFormats.response]:14},enumerations:{pin:{PA0:0,PA1:1,PA2:2,PA3:3},spi_bus:{spi1:0}},config:{CLOCK_FREQ:72000000}})),false);return d;
}
test('hardware and software SPI encode active-low select for both firmware generations',()=>{
 for(const modern of [false,true])for(const software of [undefined,false,true]){
  const d=dictionary(modern?spiFormats.config:legacySpiConfig,software),result=software===undefined?compileSpi(chip,d,0,pin('PA0'),'spi1',400000,0):compileSoftwareSpi(chip,d,0,pin('PA0'),[pin('PA1'),pin('PA2'),pin('PA3')],400000,0);
  assert.equal(result.select,`config_spi oid=0 pin=PA0${modern?' cs_active_high=0':''}`);
  assert.deepEqual(Array.from(d.encodeCommand(result.select)),modern?[10,0,0,0]:[10,0,0]);
  assert.match(result.configureBus,/mode=0 /);
 }
});
test('unsupported chip-select format and active-high requests fail closed',()=>{
 for(const software of [undefined,false,true]){
  const compile=(d:MessageDictionary,cs=pin('PA0'))=>software===undefined?compileSpi(chip,d,0,cs,'spi1'):compileSoftwareSpi(chip,d,0,cs,[pin('PA1'),pin('PA2'),pin('PA3')]);
  assert.throws(()=>compile(dictionary('config_spi oid=%c pin=%u unexpected=%c',software)),/mismatched/);
  assert.throws(()=>compile(dictionary(legacySpiConfig,software),{...pin('PA0'),invert:1} as never),/Invalid/);
 }
});
