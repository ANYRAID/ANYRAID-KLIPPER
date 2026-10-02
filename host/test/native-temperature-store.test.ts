import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeObjects,type NativeObjectReader} from '../src/moonraker/native-objects.ts';
import {TemperatureStore} from '../src/moonraker/temperature-store.ts';
import {TemperatureStoreRuntime} from '../src/moonraker/temperature-store-runtime.ts';
test('native temperature history discovers sensors, samples fresh objects, filters monitors and retires its timer',async()=>{
 let temp=20,bad=false,reads=0;
 const objects=new NativeObjects(new Map<string,NativeObjectReader>([['heaters',()=>({available_sensors:['extruder','temperature_sensor host'],available_monitors:['temperature_fan chamber']})],['extruder',()=>{reads++;if(bad)throw Error('unavailable');return {temperature:temp,target:200,power:.125};}],['temperature_sensor host',()=>({temperature:42,measured_min_temp:40})],['temperature_fan chamber',()=>({temperature:25,speed:.5})]]),()=>performance.now()/1000);
 const store=new TemperatureStore({capacity:3}),runtime=new TemperatureStoreRuntime(store,()=>{throw Error('legacy cache used');});
 try{
  runtime.readyNative(objects);runtime.readyNative(objects);assert.equal(store.snapshot().extruder.temperatures.length,1);assert(!('temperature_fan chamber' in store.snapshot()));assert('temperature_fan chamber' in store.snapshot(true));assert.deepEqual(Object.keys(store.snapshot()['temperature_sensor host']),['temperatures']);
  temp=21.125;await delay(1100);assert.deepEqual(store.snapshot().extruder.temperatures,[20,21.12]);assert.equal(runtime.status.samples,1);
  const before=store.snapshot();bad=true;await delay(1100);assert.deepEqual(store.snapshot(),before);assert(runtime.status.error);bad=false;await delay(1100);assert.equal(runtime.status.error,null);assert.equal(runtime.status.samples,2);
  await runtime.close();const count=reads;await delay(1100);assert.equal(reads,count);assert.equal(runtime.status.running,false);assert.throws(()=>runtime.readyNative(objects),/closed/);
 }finally{await runtime.close();}
});
test('native history capacity failure does not retain a source or start a timer',async()=>{
 const runtime=new TemperatureStoreRuntime(new TemperatureStore({capacity:10,maxSlots:1}),()=>({})),objects=new NativeObjects(new Map<string,NativeObjectReader>([['heaters',()=>({available_sensors:['extruder']})],['extruder',()=>({temperature:20})]]),()=>1);
 try{assert.throws(()=>runtime.readyNative(objects),/capacity/);assert.equal(runtime.status.running,false);assert.equal(runtime.status.sensors,0);}finally{await runtime.close();}
});
