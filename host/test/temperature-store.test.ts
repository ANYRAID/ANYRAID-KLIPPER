import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {TemperatureStore,includeTemperatureMonitors} from '../src/moonraker/temperature-store.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/temperature-store-reference.json',import.meta.url),'utf8'),(_key,value)=>value?.negativeZero===true?-0:value);
for(const [index,group] of reference.groups.entries())test('temperature history fixed Python reference group '+index,()=>{
 const actual=group.cases.map((c:any)=>{const store=new TemperatureStore({capacity:c.capacity});return c.stages.map((s:any)=>{store.configure(s.sensors,s.monitors,s.status);for(const sample of s.samples)store.sample(sample);return [store.snapshot(),store.snapshot(true)];});});assert.deepEqual(actual,group.expected);
});
test('temperature limits and malformed readings leave history intact; snapshots cannot mutate it',()=>{
 const store=new TemperatureStore({capacity:3,maxSensors:2,maxSlots:6});store.configure(['x'],[],{x:{temperature:1,power:.125}});const before=store.snapshot();
 assert.throws(()=>store.configure(['x','y'],[],{x:{temperature:2,power:0},y:{temperature:0}}),/capacity/);assert.deepEqual(store.snapshot(),before);
 assert.throws(()=>store.sample({x:{temperature:2,power:'bad'}}),/value/);assert.deepEqual(store.snapshot(),before);
 assert.throws(()=>store.configure(['a','b','c'],[],{}),/sensors/);assert.throws(()=>new TemperatureStore({capacity:0}),RangeError);
 before.x.temperatures[0]=999;assert.equal(store.snapshot().x.temperatures[0],1);
 const hostile=new TemperatureStore({capacity:2});hostile.configure(['__proto__'],[],Object.fromEntries([['__proto__',{temperature:2.675}]]));assert.equal(Object.hasOwn(hostile.snapshot(),'__proto__'),true);assert.equal(hostile.snapshot().__proto__.temperatures[0],2.67);
});
test('temperature monitor option follows Moonraker strict Boolean conversion',()=>{
 for(const input of [undefined,false,'false','FALSE'])assert.equal(includeTemperatureMonitors(input),false);
 for(const input of [true,'true','TRUE'])assert.equal(includeTemperatureMonitors(input),true);
 for(const input of [null,1,0,{},[],' true ','yes'])assert.throws(()=>includeTemperatureMonitors(input),/include_monitors/);
});
test('generation handoff copies exact rounded rings, truncates to new capacity and prunes removed fields',()=>{
 const old=new TemperatureStore({capacity:4});old.configure(['x','removed'],['x'],{x:{temperature:-0,power:.125},removed:{temperature:10}});
 for(const temperature of [2.675,3.125,4.125,5.125])old.sample({x:{temperature}});
 const before=old.snapshot(true),next=new TemperatureStore({capacity:3},old);
 next.configure(['x','new'],[],{x:{temperature:6.125},new:{temperature:-0}});
 assert.deepEqual(next.snapshot(),{x:{temperatures:[4.12,5.12,6.12]},new:{temperatures:[-0]}});
 next.sample({x:{temperature:7}});assert.deepEqual(old.snapshot(true),before);
 old.sample({x:{temperature:99}});assert.deepEqual(next.snapshot().x.temperatures,[5.12,6.12,7]);
 const larger=new TemperatureStore({capacity:8},next);larger.configure(['x'],[],{x:{temperature:8}});assert.deepEqual(larger.snapshot().x.temperatures,[5.12,6.12,7,8]);
});
test('new generation validates changed budgets before copying history and permits retry',()=>{
 const old=new TemperatureStore();old.configure(['x'],[],{x:{temperature:-0,power:1}});const before=old.snapshot();
 const next=new TemperatureStore({capacity:2,maxSlots:2},old);
 assert.throws(()=>next.configure(['x'],[],{x:{temperature:1,power:1}}),/capacity/);assert.deepEqual(next.snapshot(),{});assert.deepEqual(old.snapshot(),before);
 next.configure(['x'],[],{x:{temperature:1}});assert.deepEqual(next.snapshot().x.temperatures,[-0,1]);
 next.configure(['x'],[],{x:{temperature:2}});assert.deepEqual(next.snapshot().x.temperatures,[1,2]);
});
