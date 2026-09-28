import test from 'node:test';
import assert from 'node:assert/strict';
import {CombinedTemperature,type CombinationMethod} from '../src/thermal/combined-temperature.ts';
const config={method:'mean' as CombinationMethod,minimum:-273.15,maximum:300,maximumDeviation:10};
test('combined sources compute minimum, maximum and compensated mean including zero',()=>{
 for(const [method,wanted] of [['min',-1],['max',1],['mean',0]] as const){const values=[-1,0,1],c=new CombinedTemperature({...config,method},values.map(temperature=>()=>({temperature,stale:false})));assert.equal(c.getTemperature().stale,true);assert.equal(c.sample(),wanted);assert.deepEqual(c.getTemperature(),{temperature:wanted,stale:false});}
});
test('combined source faults are latched and cannot revive an old valid temperature',()=>{
 for(const bad of [{temperature:NaN,stale:false},{temperature:20,stale:true},{temperature:20,stale:false,fault:'disconnected'},{temperature:40,stale:false}]){
  let reading={temperature:20,stale:false} as {temperature:number;stale:boolean;fault?:string};const c=new CombinedTemperature(config,[()=>reading,()=>({temperature:20,stale:false})]);assert.equal(c.sample(),20);reading=bad;assert.throws(()=>c.sample());assert.equal(c.getTemperature().stale,true);reading={temperature:20,stale:false};assert.throws(()=>c.sample());
 }
});
test('combination checks range, source exceptions and exact deviation boundary',()=>{
 const c=new CombinedTemperature(config,[()=>({temperature:20,stale:false}),()=>({temperature:30,stale:false})]);assert.equal(c.sample(),25);
 assert.throws(()=>new CombinedTemperature(config,[]));assert.throws(()=>new CombinedTemperature({...config,maximumDeviation:0},[()=>({temperature:20,stale:false})]));
 for(const t of [-274,301])assert.throws(()=>new CombinedTemperature(config,[()=>({temperature:t,stale:false})]).sample());
 const e=new Error('source failed'),broken=new CombinedTemperature(config,[()=>{throw e;}]);assert.throws(()=>broken.sample(),x=>x===e);assert.equal(broken.getTemperature().fault,e);
});
test('scaled compensated mean stays finite near binary64 limits',()=>{
 const c=new CombinedTemperature({...config,minimum:0,maximum:Number.MAX_VALUE,maximumDeviation:Number.MAX_VALUE},Array.from({length:128},()=>()=>({temperature:Number.MAX_VALUE/2,stale:false})));assert.equal(c.sample(),Number.MAX_VALUE/2);
});
test('optional fields aggregate only available samples and publish valid zeros',()=>{
 for(const [method,expected] of [['min',{humidity:0,pressure:10,gas:0}],['max',{humidity:50,pressure:20,gas:0}],['mean',{humidity:25,pressure:15,gas:0}]] as const){
  const c=new CombinedTemperature({...config,method},[()=>({temperature:20,stale:false,humidity:0,pressure:10,gas:null}),()=>({temperature:20,stale:false,humidity:50,pressure:20,gas:0}),()=>({temperature:20,stale:false})]);c.sample();assert.deepEqual(c.additional,expected);
  const snapshot:{gas?:number}=c.additional;snapshot.gas=100;assert.deepEqual(c.additional,expected);
 }
});
test('optional field updates are atomic, missing values clear old fields, invalid values latch failure',()=>{
 let humidity:number|null=50,pressure:number|undefined=10;const c=new CombinedTemperature(config,[()=>({temperature:20,stale:false,humidity,pressure})]);c.sample();humidity=0;pressure=undefined;c.sample();assert.deepEqual(c.additional,{humidity:0});humidity=null;c.sample();assert.deepEqual(c.additional,{});humidity=NaN;assert.throws(()=>c.sample(),/humidity/);assert(c.getTemperature().stale);assert.deepEqual(c.additional,{});
});
