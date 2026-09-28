import test from 'node:test';
import assert from 'node:assert/strict';
import {CombinedTemperatureRuntime} from '../src/thermal/combined-temperature-runtime.ts';
import {planCombinedTemperatures} from '../src/config/combined-temperature.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const config={method:'mean' as const,maximumDeviation:5,minimum:0,maximum:100};
test('runtime delays initial sampling, publishes zero, latches faults and cancels callbacks',()=>{
 let callback=()=>{},delay=0,cancelled=0,temperature=0,reads=0;const faults:unknown[]=[];
 const owner=new CombinedTemperatureRuntime('temperature_sensor combined',config,[()=>{reads++;return {temperature,stale:false};}],e=>faults.push(e),(fn,ms)=>{callback=fn;delay=ms;return ()=>{cancelled++;};});
 owner.start();assert.equal(delay,1000);assert.equal(reads,0);callback();assert.equal(delay,300);assert.equal(owner.state.getTemperature().temperature,0);assert.equal(owner.state.getTemperature().stale,false);
 temperature=101;callback();assert.equal(faults.length,1);assert.equal(cancelled,1);assert(owner.state.getTemperature().stale);const count=reads;callback();assert.equal(reads,count);assert.throws(()=>owner.start());owner.close();assert.equal(cancelled,1);
});
test('closing an owner before startup grace prevents all source access',()=>{
 let callback=()=>{},reads=0;const owner=new CombinedTemperatureRuntime('temperature_sensor combined',config,[()=>{reads++;return {temperature:20,stale:false};}],()=>assert.fail(),fn=>{callback=fn;return ()=>{};});owner.start();owner.close();callback();assert.equal(reads,0);assert(owner.state.getTemperature().stale);
});
test('combined planning sorts dependencies and rejects cycles and unknown sources',()=>{
 const make=(a:string,b:string)=>new ConfigurationReader(new ConfigurationSource('/combined.cfg',{'temperature_sensor a':{sensor_list:a,combination_method:'mean',maximum_deviation:'5'},'temperature_sensor b':{sensor_list:b,combination_method:'max',maximum_deviation:'5'}},[]),null),sections=['temperature_sensor a','temperature_sensor b'],available=[...sections,'extruder'];
 assert.deepEqual(planCombinedTemperatures(make('temperature_sensor b','extruder'),sections,available).map(p=>p.section),['temperature_sensor b','temperature_sensor a']);
 assert.throws(()=>planCombinedTemperatures(make('temperature_sensor b','temperature_sensor a'),sections,available),/cycle/);
 assert.throws(()=>planCombinedTemperatures(make('unknown','extruder'),sections,available),/unknown/);
 assert.throws(()=>planCombinedTemperatures(make('extruder','extruder'),['temperature_sensor a','temperature_sensor duplicate a'],available),/Duplicate/);
});
