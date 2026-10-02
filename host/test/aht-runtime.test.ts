import test from 'node:test';
import assert from 'node:assert/strict';
import {I2cTemperatureRuntime,type I2cTemperatureClock} from '../src/thermal/i2c-temperature-runtime.ts';
const config={section:'temperature_sensor chamber',model:'AHT2X',minimum:-50,maximum:100,reportTime:30,gcodeId:undefined};
const signal=()=>new AbortController().signal;
function timer(){let now=0;const jobs=new Set<{at:number;callback:()=>void}>();const clock:I2cTemperatureClock={now:()=>now,schedule(callback,ms){const job={at:now+ms/1000,callback};jobs.add(job);return ()=>jobs.delete(job);}};return {clock,jobs,jump(t:number){now=t;},async advance(t:number){now=t;for(const job of [...jobs])if(job.at<=now){jobs.delete(job);job.callback();}await new Promise(r=>setImmediate(r));}};}
test('AHT runtime publishes humidity and honors 30-second reporting without false seven-second expiry',async()=>{
 const time=timer();let calls=0;const sampler={async initialize(){return {temperature:25,humidity:50};},async sample(){calls++;return {temperature:0,humidity:0};}},runtime=new I2cTemperatureRuntime(config,sampler,()=>assert.fail('unexpected fault'),time.clock);
 assert.equal(runtime.getTemperature().stale,true);await runtime.start(signal());assert.equal(runtime.getTemperature().humidity,50);
 await time.advance(29);assert.equal(calls,0);assert.equal(runtime.getTemperature().stale,false);
 await time.advance(30);assert.equal(calls,1);assert.deepEqual(runtime.sensorStatus,{temperature:0,humidity:0});assert.equal(runtime.getTemperature().stale,false);
 await runtime.close();assert.equal(runtime.getTemperature().stale,true);assert.equal(time.jobs.size,0);await time.advance(100);assert.equal(calls,1);await assert.rejects(runtime.start(signal()),/restart/);
});
test('AHT runtime rejects ranges and keeps previous complete sample on failure',async()=>{
 for(const reading of [{temperature:101,humidity:20},{temperature:25,humidity:NaN}]){
  const time=timer();let faults=0;const runtime=new I2cTemperatureRuntime(config,{async initialize(){return {temperature:25,humidity:50};},async sample(){return reading;}},()=>{faults++;},time.clock);
  await runtime.start(signal());await time.advance(30);assert.equal(faults,1);assert.equal(runtime.getTemperature().stale,true);assert.deepEqual(runtime.sensorStatus,{temperature:25,humidity:50});assert.equal(time.jobs.size,0);await runtime.close();
 }
});
test('AHT acquisition timeout aborts in-flight work and prevents late publication',async()=>{
 const time=timer();let faults=0,aborted=false;const runtime=new I2cTemperatureRuntime(config,{initialize(s){return new Promise((_resolve,reject)=>s.addEventListener('abort',()=>{aborted=true;reject(s.reason);},{once:true}));},async sample(){throw Error('unused');}},()=>{faults++;},time.clock);
 const started=assert.rejects(runtime.start(signal()),/timed out/);await time.advance(6);await started;assert.equal(aborted,true);assert.equal(faults,1);assert.equal(runtime.getTemperature().stale,true);assert.equal(runtime.getTemperature().humidity,undefined);await runtime.close();assert.equal(time.jobs.size,0);
});
test('AHT read-side freshness rejects overdue samples even before delayed timer callbacks run',async()=>{
 const time=timer();let faults=0;const runtime=new I2cTemperatureRuntime(config,{async initialize(){return {temperature:25,humidity:50};},async sample(){return {temperature:25,humidity:50};}},()=>{faults++;},time.clock);
 await runtime.start(signal());time.jump(37);assert.equal(runtime.getTemperature().stale,true);assert.equal(faults,1);runtime.getTemperature();assert.equal(faults,1);assert.equal(time.jobs.size,0);await runtime.close();
});
test('AHT late completion and shutdown during startup never publish samples',async()=>{
 for(const shutdown of [false,true]){
  const time=timer(),pending=Promise.withResolvers<{temperature:number;humidity:number}>();let faults=0;const runtime=new I2cTemperatureRuntime(config,{initialize:()=>pending.promise,sample:()=>pending.promise},()=>{faults++;},time.clock);
  const started=assert.rejects(runtime.start(signal()));let closing:Promise<void>|undefined;if(shutdown)closing=runtime.close();else time.jump(7);
  pending.resolve({temperature:25,humidity:50});await started;await closing;assert.equal(runtime.getTemperature().stale,true);assert.equal(runtime.getTemperature().humidity,undefined);assert.equal(faults,shutdown?0:1);await runtime.close();
 }
});
test('AHT delayed poll cannot hide an expired sample by starting a new acquisition',async()=>{
 const time=timer();let calls=0,faults=0;const runtime=new I2cTemperatureRuntime(config,{async initialize(){return {temperature:25,humidity:50};},async sample(){calls++;return {temperature:26,humidity:51};}},()=>{faults++;},time.clock);
 await runtime.start(signal());await time.advance(37);assert.equal(calls,0);assert.equal(faults,1);assert.equal(runtime.getTemperature().stale,true);assert.deepEqual(runtime.sensorStatus,{temperature:25,humidity:50});await runtime.close();
});
