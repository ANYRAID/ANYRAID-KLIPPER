import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SubscriptionFilter,mergeSubscriptions,prepareStatus,adoptStatus,KlippyStatusCache} from '../src/moonraker/subscription-status.ts';
const plain=(v:unknown)=>JSON.parse(JSON.stringify(v));
test('subscription union deduplicates fields and null dominates without mutating callers',()=>{
 const source={toolhead:['position','position'],heater:[]},a=new SubscriptionFilter(source),b=new SubscriptionFilter({toolhead:['velocity'],heater:null}),c=new SubscriptionFilter({toolhead:null});source.toolhead[0]='changed';assert.deepEqual(mergeSubscriptions([a,b]).objects,{toolhead:['position','velocity'],heater:null});assert.deepEqual(mergeSubscriptions([a,b,c]).objects,{toolhead:null,heater:null});assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.objects.toolhead));assert.deepEqual(mergeSubscriptions([]).objects,{});
});
test('projection preserves requested fields and distinguishes empty snapshot objects from update notifications',()=>{
 const status=prepareStatus({toolhead:{position:[1,2,3],velocity:100},heater:{temperature:25},empty:{}}),filter=new SubscriptionFilter({toolhead:['position'],heater:[],empty:null,missing:null});assert.deepEqual(plain(filter.project(status)),{toolhead:{position:[1,2,3]}});assert.deepEqual(plain(filter.project(status,true)),{toolhead:{position:[1,2,3]},heater:{},empty:{}});assert.ok(Object.isFrozen(filter.project(status).toolhead.position));assert.throws(()=>filter.project({toolhead:{position:1}}),/prepared/);
});
test('prepared status isolates inputs, preserves exact strings and supports special own property names',()=>{
 const input=JSON.parse('{"__proto__":{"constructor":[1,2]},"configfile":{"config":{"x":1}},"position":{"value":1e20,"exact":"9007199254740993"}}'),status=prepareStatus(input);input.__proto__.constructor[0]=9;const filter=new SubscriptionFilter(JSON.parse('{"__proto__":null,"position":null}'));assert.deepEqual(plain(filter.project(status)),JSON.parse('{"__proto__":{"constructor":[1,2]},"position":{"value":1e20,"exact":"9007199254740993"}}'));assert.equal(({} as any).value,undefined);assert.ok(Object.isFrozen(status.configfile.config));
});
test('invalid subscriptions and status shapes reject consistently',()=>{
 for(const v of [null,[],{toolhead:true},{toolhead:[1]},{'':null},{toolhead:['']},{toolhead:['x'.repeat(257)]}])assert.throws(()=>new SubscriptionFilter(v));for(const v of [null,[],{toolhead:1},{toolhead:[]},{toolhead:{n:NaN}},{'':{}}])assert.throws(()=>prepareStatus(v));assert.throws(()=>new KlippyStatusCache({bytes:1}));
});
test('cache merges partial updates without mutating older snapshots and clears on reset',()=>{
 const cache=new KlippyStatusCache();cache.apply(prepareStatus({toolhead:{position:[1,2,3],velocity:100},heater:{temperature:20}}));const before=cache.read();cache.apply(prepareStatus({toolhead:{velocity:120}}));assert.deepEqual(plain(cache.read()),{toolhead:{position:[1,2,3],velocity:120},heater:{temperature:20}});assert.equal(before.toolhead.velocity,100);assert.ok(Object.isFrozen(cache.read().toolhead));assert.equal(cache.metrics.fields,3);cache.clear();assert.deepEqual(plain(cache.read()),{});assert.equal(cache.metrics.bytes,2);
});
test('replacement prunes removed fields and objects and reports only changed previously cached fields',()=>{
 const cache=new KlippyStatusCache();cache.apply(prepareStatus({toolhead:{x:1,gone:2},removed:{value:true}}));const result=cache.replace(prepareStatus({toolhead:{x:2,new:3},added:{x:1}}));assert.equal(result.applied,true);assert.deepEqual(plain(result.difference),{toolhead:{x:2}});assert.deepEqual(plain(cache.read()),{toolhead:{x:2,new:3},added:{x:1}});
});
test('snapshot comparison matches Python JSON equality for booleans, signed zero, objects and arrays',()=>{
 const cache=new KlippyStatusCache();cache.apply(prepareStatus({object:{a:false,b:-0,c:{x:1,y:2},d:[1,2]}}));const result=cache.replace(prepareStatus({object:{a:0,b:0,c:{y:2,x:1},d:[2,1]}}));assert.deepEqual(plain(result.difference),{object:{d:[2,1]}});
});
test('cache excludes config/settings consistently while returned subscription data remains intact',()=>{
 const cache=new KlippyStatusCache(),status=prepareStatus({configfile:{config:{large:'x'},settings:{y:2},save_config_pending:true}});cache.replace(status);assert.deepEqual(plain(cache.read()),{configfile:{save_config_pending:true}});cache.apply(status);assert.deepEqual(plain(cache.read()),{configfile:{save_config_pending:true}});assert.deepEqual(plain(new SubscriptionFilter({configfile:null}).project(status)),plain(status));
});
test('stale snapshots cannot overwrite a newer update or prune its objects',()=>{
 const cache=new KlippyStatusCache();cache.apply(prepareStatus({toolhead:{x:1}}));const revision=cache.revision;cache.apply(prepareStatus({toolhead:{x:2},newer:{x:3}}));const result=cache.replace(prepareStatus({toolhead:{x:0}}),revision);assert.equal(result.applied,false);assert.deepEqual(plain(result.difference),{});assert.deepEqual(plain(cache.read()),{toolhead:{x:2},newer:{x:3}});
});
test('object, field and byte overflow are atomic across all changed objects',()=>{
 for(const limits of [{objects:1},{fields:1},{bytes:40}]){const cache=new KlippyStatusCache(limits);cache.apply(prepareStatus({one:{x:1}}));const before=cache.read(),metrics=cache.metrics;assert.throws(()=>cache.apply(prepareStatus({one:{x:2},two:{long:'x'.repeat(100)}})),/capacity/);assert.deepEqual(cache.read(),before);assert.deepEqual(cache.metrics,metrics);assert.throws(()=>cache.replace(prepareStatus({one:{x:3,y:'x'.repeat(100)},two:{z:4}})),/capacity/);assert.deepEqual(cache.read(),before);assert.deepEqual(cache.metrics,metrics);}
});
test('fused immutable copying preserves signed zero, sparse arrays and extra array properties',()=>{
 const array:any[]=[-0,1e20];array.length=4;Object.defineProperty(array,'extra',{value:{exact:'9007199254740993'},enumerable:true});const status=prepareStatus({motion:{value:array}}),copy=status.motion.value as any[];assert.equal(Object.is(copy[0],-0),true);assert.equal(copy[1],1e20);assert.equal(2 in copy,false);assert.equal((copy as any).extra.exact,'9007199254740993');assert.ok(Object.isFrozen((copy as any).extra));const cache=new KlippyStatusCache();cache.apply(prepareStatus({motion:{x:0}}));cache.apply(prepareStatus({motion:{x:-0}}));assert.equal(Object.is(cache.read().motion.x,-0),true);
});
test('aggregate subscription limits stop growth across individually valid filters',()=>{
 const a=new SubscriptionFilter(Object.fromEntries(Array.from({length:4096},(_,i)=>['a'+i,null]))),b=new SubscriptionFilter({extra:null});assert.throws(()=>mergeSubscriptions([a,b]),/capacity/);const fields=Array.from({length:1000},(_,i)=>'f'+i),left=new SubscriptionFilter(Object.fromEntries(Array.from({length:60},(_,i)=>['left'+i,fields]))),right=new SubscriptionFilter(Object.fromEntries(Array.from({length:60},(_,i)=>['right'+i,fields])));assert.throws(()=>mergeSubscriptions([left,right]),/capacity/);
});

test('owned status adoption freezes nested values even beneath an already frozen parent',()=>{
 const child={position:[1,2,3]},input=Object.freeze({toolhead:child}),adopted=adoptStatus(input);assert.equal(adopted,input);assert.ok(Object.isFrozen(child));assert.ok(Object.isFrozen(child.position));assert.throws(()=>child.position.push(4));const invalid={good:{x:1},bad:{x:Infinity}};assert.throws(()=>adoptStatus(invalid));assert.equal(Object.isFrozen(invalid.good),false);
});
