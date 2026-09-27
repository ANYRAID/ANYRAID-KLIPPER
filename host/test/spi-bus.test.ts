import test from 'node:test';
import assert from 'node:assert/strict';
import {PrinterPins} from '../src/protocol/pins.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {spiBusRequests} from '../src/config/spi-bus.ts';
function fixture(){
 const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{'spi_set_bus oid=%c spi_bus=%u mode=%u rate=%u':10},responses:{},enumerations:{pin:{PA0:0,PA1:1,PA2:2,PA3:3,PA6:6,PA7:7,PA8:8,PA9:9},spi_bus:{spi1:0,alias1:0,spi2:1,swap:2}},config:{BUS_PINS_spi1:'PA6,PA7,PA8',BUS_PINS_alias1:'PA6,PA7,PA8',BUS_PINS_spi2:'PA6,PA7,PA8',BUS_PINS_swap:'PA7,PA6,PA8'}})),false);
 const pins=new PrinterPins<object>();pins.register('mcu',{});const mappings=new Map([['mcu',{pins:dictionary.pinEnumeration}]]);
 const hardware=(bus='spi1')=>spiBusRequests(pins,'mcu',dictionary,bus),software=(names=['PA6','PA7','PA8'])=>spiBusRequests(pins,'mcu',dictionary,'software',names.map(p=>pins.parse(p)));
 return {pins,dictionary,mappings,hardware,software};
}
test('hardware bus aliases share canonical firmware identity; chip selects stay exclusive',()=>{
 const f=fixture(),a=f.pins.lookupBatch([{description:'PA0',exclusive:true},...f.hardware()],f.mappings),b=f.pins.lookupBatch([{description:'PA1',exclusive:true},...f.hardware('alias1')],f.mappings);
 assert.equal(f.pins.claimedPins.length,5);assert.deepEqual(a.slice(1),b.slice(1));
 assert.throws(()=>f.pins.lookupBatch([{description:'PA0',exclusive:true},...f.hardware()],f.mappings),/multiple/);
 assert.throws(()=>f.pins.lookupBatch([{description:'PA6',exclusive:true}],f.mappings),/multiple/);
});
test('strict bus sharing survives multi-use overrides and cannot be reset under other owners',()=>{
 const f=fixture(),owned=f.pins.lookupBatch(f.hardware(),f.mappings);f.pins.allowMultiUse('PA6');
 assert.throws(()=>f.pins.lookup('PA6'),/multiple/);assert.throws(()=>f.pins.lookupBatch(f.software(),f.mappings),/multiple/);assert.throws(()=>f.pins.resetSharing(owned[0]),/Shared bus/);
 assert.equal(f.pins.lookupBatch(f.hardware(),f.mappings)[0],owned[0]);
});
test('backend, bus controller, signal roles and partial overlaps cannot be shared',()=>{
 const f=fixture();f.pins.lookupBatch(f.hardware(),f.mappings);
 for(const requests of [f.hardware('spi2'),f.hardware('swap'),f.software(),f.software(['PA6','PA7','PA9'])])assert.throws(()=>f.pins.lookupBatch(requests,f.mappings),/multiple/);
 assert.equal(f.pins.claimedPins.length,3);
});
test('software pin aliases share complete wiring while duplicate signals are rejected',()=>{
 const f=fixture();f.pins.resolver('mcu').alias('MISO','PA6');f.pins.resolver('mcu').alias('SCK','PA8');const a=f.pins.lookupBatch(f.software(),f.mappings),b=f.pins.lookupBatch(f.software(['MISO','PA7','SCK']),f.mappings);assert.deepEqual(a,b);
 assert.throws(()=>f.software(['PA6','MISO','PA8']),/alias|overlap/);
 assert.throws(()=>f.software(['PA6','PA6','PA8']),/overlap/);
});
test('hardware metadata cannot be redirected through board aliases',()=>{
 const f=fixture();f.pins.resolver('mcu').alias('PA6','PA9');assert.throws(()=>f.hardware(),/physical wiring/);assert.equal(f.pins.claimedPins.length,0);
});
test('failed pin batch does not leak new claims or upgrade existing sharing policy',()=>{
 const f=fixture();f.pins.lookupBatch([{description:'PA6',options:{shareType:'old'}}],f.mappings);f.pins.allowMultiUse('PA6');
 assert.throws(()=>f.pins.lookupBatch([{description:'PA6',options:{shareType:'old'},strictSharing:true},{description:'PA0',exclusive:true},{description:'unknown'}],f.mappings));
 assert.equal(f.pins.claimedPins.length,1);assert.doesNotThrow(()=>f.pins.lookup('PA6',{shareType:'another'}));
 assert.throws(()=>f.pins.lookupBatch([{description:'PA0',strictSharing:true}],f.mappings),/share type/);
});
