import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {TemperatureStore,includeTemperatureMonitors} from '../src/moonraker/temperature-store.ts';
import {temperatureStoreOracle} from './helpers/temperature-store-oracle.ts';
import type {StatusView} from '../src/moonraker/subscription-status.ts';
test('temperature history matches Python rounding, nulls, retained fields, monitors and missing readings',()=>{
 const stages=[
  {sensors:['extruder','fan','empty'],monitors:['monitor'],status:{extruder:{temperature:2.675,target:210,power:.125},fan:{speed:.995},monitor:{temperature:null},empty:{ignored:1}},samples:[{extruder:{temperature:1.005,power:.135},monitor:{temperature:-2.675}},{},{extruder:{temperature:null}}]},
  {sensors:['extruder','new'],monitors:['monitor'],status:{extruder:{temperature:21.235,speed:.345},new:{target:99.999},monitor:{temperature:100.555}},samples:Array.from({length:6},(_,i)=>({extruder:{temperature:i+.125},monitor:{temperature:i}}))},
  {sensors:[],monitors:[],status:{},samples:[]}
 ] as {sensors:string[];monitors:string[];status:StatusView;samples:StatusView[]}[];
 const cases=[1,3,1200].map(capacity=>({capacity,stages})),result=spawnSync('/usr/bin/python3',['-c',temperatureStoreOracle()],{input:JSON.stringify(cases),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const actual=cases.map(c=>{const store=new TemperatureStore({capacity:c.capacity});return c.stages.map(s=>{store.configure(s.sensors,s.monitors,s.status);for(const sample of s.samples)store.sample(sample);return [store.snapshot(),store.snapshot(true)];});});assert.deepEqual(actual,JSON.parse(result.stdout));
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
test('temperature decimal rounding matches Python over changing exponent and signed tie cases',()=>{
 const values=[2.675,-2.675,.005,-.005,1.005,1e100,-1e100,1e-100,-1e-100,9999999999999.875,-9999999999999.875,...Array.from({length:1000},(_,i)=>Math.sin(i*17.31)*10**(i%12-6))];
 const stage={sensors:['x'],monitors:[],status:{x:{temperature:0}},samples:values.map(temperature=>({x:{temperature}}))},cases=[{capacity:1200,stages:[stage]}];
 const result=spawnSync('/usr/bin/python3',['-c',temperatureStoreOracle()],{input:JSON.stringify(cases),encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 const store=new TemperatureStore();store.configure(stage.sensors,[],stage.status);for(const sample of stage.samples)store.sample(sample);assert.deepEqual([[ [store.snapshot(),store.snapshot(true)] ]],JSON.parse(result.stdout));
});

test('round-to-even fast path matches adjacent binary floats on both sides of decimal ties',()=>{
 const values:number[]=[];const buffer=new ArrayBuffer(8),view=new DataView(buffer);
 for(let i=0;i<1000;i++){const tie=(i*2+1)/8;view.setFloat64(0,tie);const bits=view.getBigUint64(0);for(const offset of [-1n,0n,1n]){view.setBigUint64(0,bits+offset);values.push(view.getFloat64(0),-view.getFloat64(0));}}
 const stage={sensors:['x'],monitors:[],status:{x:{temperature:0}},samples:values.map(temperature=>({x:{temperature}}))},cases=[{capacity:10000,stages:[stage]}];
 const result=spawnSync('/usr/bin/python3',['-c',temperatureStoreOracle()],{input:JSON.stringify(cases),encoding:'utf8',maxBuffer:4*1024*1024});assert.equal(result.status,0,result.stderr);
 const store=new TemperatureStore({capacity:10000});store.configure(stage.sensors,[],stage.status);for(const sample of stage.samples)store.sample(sample);assert.deepEqual([[[store.snapshot(),store.snapshot(true)]]],JSON.parse(result.stdout));
});
