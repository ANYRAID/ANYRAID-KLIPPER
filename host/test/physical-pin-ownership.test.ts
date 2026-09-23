import test from 'node:test';
import assert from 'node:assert/strict';
import {PrinterPins,type PhysicalPinMap} from '../src/protocol/pins.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {compileConfiguredSteppers} from '../src/config/stepper.ts';
import {stepperBatchFixture,batchReader} from './helpers/configured-steppers.ts';
const mapping=()=>({pins:{PA0:0,PA0_ALIAS:0,PA1:1,PA2:2,PA3:3,PA4:4,PA5:5}}),registry=()=>{const p=new PrinterPins<object>();p.register('mcu',{});return p;};
test('later output acquisition cannot reuse accepted step pins via GPIO aliases or multi-use',()=>{
 const f=stepperBatchFixture(),plans=compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x',oid:1}]);f.pins.allowMultiUse('PA0_ALIAS');assert.throws(()=>f.pins.resetSharing(plans[0].step),/new hardware registry/);
 assert.throws(()=>f.pins.lookup('PA0_ALIAS'),/multiple/);assert.throws(()=>f.pins.lookup('PA0_ALIAS',{shareType:'enable'}),/multiple/);assert.equal(f.pins.claimedPins.length,2);assert.equal(f.pins.lookup('PA2').pin,'PA2');
 assert.throws(()=>f.pins.register('shadow',plans[0].step.chip),/physical chip/);
});
test('physical sharing preserves the registered owner and validates polarity',()=>{
 const p=registry();const [owner]=p.lookupBatch([{description:'!PA0',options:{canInvert:true,shareType:'enable'}}],new Map([['mcu',mapping()]]));
 assert.equal(p.lookup('!PA0_ALIAS',{canInvert:true,shareType:'enable'}),owner);assert.equal(p.claimedPins.length,1);assert.throws(()=>p.lookup('PA0_ALIAS',{shareType:'enable'}),/polarity/);assert.throws(()=>p.lookup('!PA0_ALIAS',{canInvert:true,shareType:'fan'}),/multiple/);
});
test('firmware and subsequently added machine reservations apply to later GPIO aliases',()=>{
 const f=stepperBatchFixture(true);compileConfiguredSteppers(batchReader(),f.pins,f.mcus,[{section:'stepper_x',oid:1}]);assert.throws(()=>f.pins.lookup('PA3_ALIAS'),/reserved/);
 const p=registry();p.lookupBatch([{description:'PA1'}],new Map([['mcu',mapping()]]));p.resolver('mcu').reserve('PA0','machine');assert.throws(()=>p.lookup('PA0_ALIAS'),/reserved/);
});
test('failed batches do not publish mappings and committed mappings own immutable snapshots',()=>{
 const p=registry(),source=mapping();assert.throws(()=>p.lookupBatch([{description:'PA0'},{description:'PA0_ALIAS'}],new Map([['mcu',source]])),/multiple/);assert.equal(p.claimedPins.length,0);const untyped=p.lookup('CUSTOM');p.resetSharing(untyped);
 p.lookupBatch([{description:'PA1'}],new Map([['mcu',source]]));source.pins.PA0=5;const owner=p.lookup('PA0');assert.throws(()=>p.lookup('PA0_ALIAS'),/multiple/);assert.equal(owner.pin,'PA0');
 assert.throws(()=>p.lookupBatch([{description:'PA4'}],new Map([['mcu',source]])),/mapping changed/);assert.equal(p.lookup('PA4').pin,'PA4');
});
test('installing a physical namespace refuses preexisting separate owners of the same GPIO',()=>{
 const p=registry(),first=p.lookup('PA0'),second=p.lookup('PA0_ALIAS');assert.throws(()=>p.lookupBatch([{description:'PA1'}],new Map([['mcu',mapping()]])),/overlap/);assert.deepEqual(p.claimedPins,[first,second]);assert.equal(p.lookup('CUSTOM').pin,'CUSTOM');
});
test('alias retargeting after physical acquisition cannot silently move an existing owner',()=>{
 const p=registry();p.resolver('mcu').alias('STEP','PA0');const [owner]=p.lookupBatch([{description:'STEP'}],new Map([['mcu',mapping()]]));p.resolver('mcu').alias('PA0','PA4');assert.throws(()=>p.lookup('PA5'),/changed after acquisition/);assert.deepEqual(p.claimedPins,[owner]);
});
test('exclusive claims persist within a batch and across later non-mapped lookups',()=>{
 const p=registry();p.allowMultiUse('PA0');assert.throws(()=>p.lookupBatch([{description:'PA0',exclusive:true},{description:'PA0'}]),/multiple/);assert.equal(p.claimedPins.length,0);p.lookupBatch([{description:'PA0',exclusive:true}]);assert.throws(()=>p.lookup('PA0'),/exclusively/);
});
test('dictionary GPIO snapshots are immutable and reject inconsistent command namespaces',()=>{
 const f=stepperBatchFixture(),snapshot=f.dictionary.pinEnumeration;assert.equal(snapshot.PA0_ALIAS,snapshot.PA0);assert.throws(()=>{(snapshot as Record<string,number>).PA0=5;});
 const raw=JSON.parse(Buffer.from(f.dictionary.rawIdentify).toString());raw.enumerations={step_pin:{PA0:99},...raw.enumerations};const other=new MessageDictionary();other.identify(Buffer.from(JSON.stringify(raw)),false);assert.throws(()=>other.pinEnumeration,/Inconsistent/);
 const p=registry();for(const bad of [{pins:{PA0:-1}},{pins:{PA0:1.5}},{pins:{PA0:0},reserved:[NaN]}] as PhysicalPinMap[])assert.throws(()=>p.lookupBatch([{description:'PA0'}],new Map([['mcu',bad]])),/Invalid physical/);assert.equal(p.claimedPins.length,0);
 p.register('shadow',p.parse('PA0').chip);assert.throws(()=>p.lookupBatch([{description:'PA0'}],new Map([['mcu',mapping()]])),/Physical chip has multiple names/);assert.equal(p.claimedPins.length,0);
});
