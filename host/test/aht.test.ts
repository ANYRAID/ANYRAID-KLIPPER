import test from 'node:test';
import assert from 'node:assert/strict';
import {AhtSensor,decodeAht,type AhtModel} from '../src/thermal/aht.ts';
const signal=()=>new AbortController().signal;
const frame=(temperature:number,humidity:number,status=8)=>Uint8Array.of(status,humidity>>>12,(humidity>>>4)&255,((humidity&15)<<4)|(temperature>>>16),temperature>>>8&255,temperature&255);
test('AHT conversion covers every 20-bit temperature and humidity word exactly',()=>{
 for(let raw=0;raw<1048576;raw++){
  const humidity=1048575-raw,result=decodeAht(frame(raw,humidity));
  assert.equal(result.temperature,raw*200/1048576-50);assert.equal(result.humidity,Math.floor(humidity*100/1048576));
 }
 for(const data of [Buffer.alloc(5),Buffer.alloc(7),frame(0,0,0),frame(0,0,0x88)])assert.throws(()=>decodeAht(data));
 assert.deepEqual(decodeAht(frame(0,0)),{temperature:-50,humidity:0});
});
test('AHT family startup and sampling preserve commands and minimum waits',async()=>{
 for(const model of ['AHT10','AHT1X','AHT2X','AHT3X'] as AhtModel[]){
  const events:unknown[]=[],sensor=new AhtSensor({async transfer(bytes,n){events.push([...bytes]);return n?frame(393216,524288):Buffer.alloc(0);}},model,async ms=>{events.push(ms);});
  assert.deepEqual(await sensor.initialize(signal()),{temperature:25,humidity:50});
  assert.deepEqual(events,[...(model==='AHT3X'?[]:[[model==='AHT2X'?0xbe:0xe1,8,0]]),model==='AHT10'||model==='AHT1X'?40:100,[0xac,0x33,0],110,[]]);
  await assert.rejects(sensor.initialize(signal()),/restart/);assert.deepEqual(await sensor.sample(signal()),{temperature:25,humidity:50});
 }
});
test('AHT busy exhaustion resets once and latches failure instead of valid zeros',async()=>{
 let reads=0,resets=0;const waits:number[]=[],sensor=new AhtSensor({async transfer(bytes,n){if(bytes[0]===0xba)resets++;if(n)reads++;return n?frame(0,0,0x88):Buffer.alloc(0);}},'AHT2X',async ms=>{waits.push(ms);});
 await assert.rejects(sensor.initialize(signal()),/six measurements/);assert.equal(reads,6);assert.equal(resets,1);assert.deepEqual(waits,[100,...Array(6).fill(110),20]);await assert.rejects(sensor.sample(signal()),/six measurements/);assert.equal(reads,6);
});
test('AHT rejects uncalibrated and truncated frames without resetting or resampling',async()=>{
 for(const data of [frame(0,0,0),Buffer.alloc(5)]){let reads=0;const sensor=new AhtSensor({async transfer(_bytes,n){if(n)reads++;return n?data:Buffer.alloc(0);}},'AHT3X',async()=>{});
  await assert.rejects(sensor.initialize(signal()),/uncalibrated|Malformed/);await assert.rejects(sensor.sample(signal()));assert.equal(reads,1);
 }
});
test('AHT cancellation during conversion prevents read and concurrent sampling is rejected',async()=>{
 const waiting=Promise.withResolvers<void>(),entered=Promise.withResolvers<void>(),abort=new AbortController();let reads=0;
 const sensor=new AhtSensor({async transfer(_bytes,n){if(n)reads++;return n?frame(0,0):Buffer.alloc(0);}},'AHT3X',async ms=>{if(ms===110){entered.resolve();await waiting.promise;}});
 const result=assert.rejects(sensor.initialize(abort.signal),/cancel/);await entered.promise;await assert.rejects(sensor.sample(signal()),/already active/);abort.abort(new Error('cancel'));waiting.resolve();await result;assert.equal(reads,0);await assert.rejects(sensor.sample(signal()),/cancel/);
});
