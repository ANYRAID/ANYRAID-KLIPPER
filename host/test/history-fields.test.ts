import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {HistoryTracker,historyStrategies,type HistoryNumberType} from '../src/moonraker/history-tracker.ts';
import type {Json} from '../src/moonraker/rpc.ts';
import {historyReference} from './helpers/history-reference.ts';
type Op={kind:'state';active:boolean;paused:boolean}|{kind:'update';value:Json;numberType?:HistoryNumberType}|{kind:'pause';exclude:boolean}|{kind:'reset';value?:Json;numberType?:HistoryNumberType};
test('registered field configuration and snapshots match pinned upstream with mixed integer and float samples',()=>{
 const ops:Op[]=[{kind:'state',active:true,paused:false}];
 for(const numberType of ['integer','float'] as const){ops.push({kind:'reset',value:15,numberType});for(const value of [15,-15,25,true,false])ops.push({kind:'update',value,numberType});}
 ops.push({kind:'reset'}, {kind:'update',value:2.675},{kind:'pause',exclude:true},{kind:'state',active:true,paused:true},{kind:'update',value:50},{kind:'state',active:true,paused:false},{kind:'update',value:51},{kind:'reset',value:[1,true]},{kind:'update',value:{x:[1]}},{kind:'update',value:{x:[true]}},{kind:'reset',value:null});
 const cases=historyStrategies.flatMap(strategy=>[null,2,-1].map(precision=>({strategy,precision,ops})));
 const input=JSON.stringify(cases),expected=historyReference<unknown[]>('history-fields',input);
 assert.throws(()=>historyReference('history-fields',input.replace('"precision":2','"precision":3')),/reference input changed/);
 for(const [i,c] of cases.entries()){
  let active=false,paused=false;const fields=new HistoryFields(exclude=>active&&!(exclude&&paused)),field=fields.register({provider:'sensor',name:'reading',description:'Reading',strategy:c.strategy,units:'J',reportTotal:true,reportMaximum:true,precision:c.precision});
  const actual=c.ops.map(op=>{switch(op.kind){case 'state':active=op.active;paused=op.paused;break;case 'update':field.tracker.update(op.value,op.numberType);break;case 'pause':field.tracker.setExcludePaused(op.exclude);break;case 'reset':field.tracker.setResetCallback(op.value===undefined?undefined:()=>op.value!,op.numberType);fields.reset();break;}return {configuration:field.configuration,snapshot:fields.snapshot()};});
  assert.deepEqual(actual,expected[i],`${c.strategy}, precision=${c.precision}`);
 }
});
test('integer delta avoids intermediate cancellation loss and integer overflow preserves prior state',()=>{
 const delta=new HistoryTracker({strategy:'delta',trackingEnabled:()=>true,numberType:'integer',reset:()=>0});delta.reset();delta.update(Number.MAX_SAFE_INTEGER);delta.update(-2);assert.equal(delta.value,-2);assert.equal(delta.isFloat,false);delta.update(Number.MAX_SAFE_INTEGER);assert.equal(delta.value,Number.MAX_SAFE_INTEGER);
 const total=new HistoryTracker({strategy:'accumulate',trackingEnabled:()=>true,numberType:'integer'});total.update(Number.MAX_SAFE_INTEGER);assert.throws(()=>total.update(1),/overflow/);assert.equal(total.value,Number.MAX_SAFE_INTEGER);assert.equal(total.isFloat,false);
 assert.throws(()=>total.update(1.5),/integer/);total.update(.5,'float');assert.equal(total.isFloat,true);
});
test('registry preserves provider identity, bounded registration and configuration ownership',()=>{
 const fields=new HistoryFields(()=>true),options={provider:'sensor',name:'reading',description:'value',strategy:'BASIC',precision:2};const field=fields.register(options);options.description='changed';assert.equal(field.configuration.description,'value');field.configuration.description='mutated';assert.equal(field.configuration.description,'value');
 assert.throws(()=>fields.register(options),/already registered/);assert.throws(()=>fields.register({...options,provider:'history'}),/reserved/);assert.throws(()=>fields.register({...options,precision:1.2}),/Invalid/);
 fields.register({...options,provider:'another'});for(let i=0;i<62;i++)fields.register({...options,name:String(i)});assert.throws(()=>fields.register({...options,name:'overflow'}),/capacity/);
 const snapshot=fields.snapshot();snapshot.data[0]='changed';assert.equal(typeof fields.snapshot().data[0],'object');
});
test('invalid reset callbacks and unsafe declared integer samples leave tracked values intact',()=>{
 const fields=new HistoryFields(()=>true),field=fields.register({provider:'sensor',name:'count',description:'Count',strategy:'basic',numberType:'integer',precision:-1});field.tracker.update(15);assert.equal(field.snapshot().data.value,15);
 assert.throws(()=>field.tracker.update(1e20),/integer/);assert.equal(field.tracker.value,15);
 field.tracker.setResetCallback((async()=>{throw new Error('callback');}) as any);assert.throws(()=>fields.reset(),/synchronous/);assert.equal(field.tracker.value,15);
 const collect=fields.register({provider:'spoolman',name:'spool_ids',description:'IDs',strategy:'collect',numberType:'integer'});assert.throws(()=>collect.tracker.update(1e20),/integer/);assert.deepEqual(collect.tracker.value,[]);
});
test('integer zero has no float sign and extrema preserve the selected operand type on ties',()=>{
 for(const strategy of ['basic','delta','accumulate','average','maximum','minimum'] as const){const tracker=new HistoryTracker({strategy,trackingEnabled:()=>true,numberType:'integer',reset:()=>-0});tracker.reset();tracker.update(-0);assert.equal(Object.is(tracker.value,-0),false);}
 const fields=new HistoryFields(()=>true),field=fields.register({provider:'sensor',name:'maximum',description:'value',strategy:'maximum',precision:-1});
 field.tracker.update(true);field.tracker.update(1,'float');assert.equal(field.snapshot().data.value,true);
 field.tracker.reset();field.tracker.update(1,'float');field.tracker.update(true);assert.equal(field.snapshot().data.value,0);
});
