import test from 'node:test';
import assert from 'node:assert/strict';
import {Bme280Sensor,bme280ConversionMs} from '../src/thermal/bme280.ts';
import {bme280Device} from './helpers/bme280-device.ts';
const defaults={temperature:2,pressure:2,humidity:2,filter:1},signal=()=>new AbortController().signal;
test('BME280 uses actual oversampling multipliers and preserves optional channels',async()=>{
 assert.equal(bme280ConversionMs({temperature:5,pressure:5,humidity:5,filter:4},true),112.8);assert.equal(bme280ConversionMs({temperature:1,pressure:0,humidity:0,filter:0},true),3.55);
 for(const humidity of [false,true])for(const pressure of [0,1,5])for(const hum of [0,1,5]){let time=0;const f=bme280Device(humidity,()=>time),sensor=new Bme280Sensor({async transfer(b,n){return f.exchange(0,b,n).data;}},{...defaults,temperature:5,pressure,humidity:hum},async ms=>{time+=ms;});
  const value=await sensor.initialize(signal());assert.equal(value.temperature,25);assert.equal(value.pressure,pressure?1000:undefined);assert.equal(value.humidity,humidity&&hum?50:undefined);assert.equal(sensor.chipType,humidity?'BME280':'BMP280');f.state.temperature=60;assert.equal((await sensor.sample(signal())).temperature,60);assert.equal(f.state.conversions,2);assert.equal(f.state.reads,2);
 }
});
test('BME280 busy timeout and lost settings fail before publishing or retrying',async()=>{
 for(const mode of ['busy','settings','transport']){let time=0;const f=bme280Device(true,()=>time);f.state.stuck=mode==='busy';f.state.ignoreWrites=mode==='settings';const sensor=new Bme280Sensor({async transfer(b,n){if(f.state.fault)throw Error('NACK');return f.exchange(0,b,n).data;}},defaults,async ms=>{time+=ms;});
  if(mode==='transport'){await sensor.initialize(signal());f.state.fault=true;await assert.rejects(sensor.sample(signal()),/NACK/);}else await assert.rejects(sensor.initialize(signal()),mode==='busy'?/busy timeout/:/verification/);
  const reads=f.state.reads;await assert.rejects(sensor.sample(signal()));assert.equal(f.state.reads,reads);if(mode==='busy')assert.equal(f.state.configurationReads,50);
 }
});
test('BME280 cancellation after reset prevents calibration and conversion',async()=>{
 const f=bme280Device(),abort=new AbortController(),sensor=new Bme280Sensor({async transfer(b,n){return f.exchange(0,b,n).data;}},defaults,async()=>abort.abort(new Error('cancel')));await assert.rejects(sensor.initialize(abort.signal),/cancel/);assert.equal(f.state.conversions,0);
 for(const options of [{...defaults,temperature:0},{...defaults,pressure:6},{...defaults,filter:5}])assert.throws(()=>bme280ConversionMs(options,true),/settings/);
});
