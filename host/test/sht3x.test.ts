import test from 'node:test';
import assert from 'node:assert/strict';
import {Sht3xSensor,sht3xCrc,decodeSht3x} from '../src/thermal/sht3x.ts';
const signal=()=>new AbortController().signal;
function referenceCrc(word:number){let crc=255;for(const byte of [word>>>8,word&255]){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&128?(crc<<1)^49:crc<<1;}return crc&255;}
const bytes=(n:number)=>[n>>>8,n&255,referenceCrc(n)];
const frame=(t:number,h:number)=>Uint8Array.from([...bytes(t),...bytes(h)]);
test('SHT3X table CRC and conversions cover all 65536 raw words',()=>{
 for(let n=0;n<65536;n++){assert.equal(sht3xCrc(n),referenceCrc(n));assert.deepEqual(decodeSht3x(frame(n,65535-n)),{temperature:-45+175*n/65535,humidity:100*(65535-n)/65535});}
 assert.equal(sht3xCrc(0xbeef),0x92);for(const n of [-1,65536,NaN,1.5])assert.throws(()=>sht3xCrc(n));
});
test('SHT3X rejects every single-bit payload corruption and malformed length',()=>{
 const valid=frame(12345,54321);for(let bit=0;bit<48;bit++){const corrupt=valid.slice();corrupt[bit>>>3]^=1<<(bit&7);assert.throws(()=>decodeSht3x(corrupt),/checksum/);}
 for(const length of [0,3,5,7])assert.throws(()=>decodeSht3x(Buffer.alloc(length)),/Malformed/);
});
test('SHT3X startup preserves reset, status and periodic measurement ordering',async()=>{
 let time=0;const events:unknown[]=[],sensor=new Sht3xSensor({async transfer(data,n){events.push([...data]);return n===3?Uint8Array.from(bytes(0x10)):n===6?frame(0,65535):Buffer.alloc(0);}},async ms=>{events.push(ms);time+=ms;},()=>time);
 assert.deepEqual(await sensor.initialize(signal()),{temperature:-45,humidity:100});assert.deepEqual(events,[[48,147],1.5,[48,162],1.5,[243,45],[34,54],15.5,[224,0]]);
 await assert.rejects(sensor.initialize(signal()),/restart/);await sensor.sample(signal());assert.deepEqual(events.at(-1),[224,0]);
});
test('SHT3X status CRC and measurement CRC failures latch without publishing old or zero fields',async()=>{
 for(const statusFault of [true,false]){let calls=0;const sensor=new Sht3xSensor({async transfer(_data,n){calls++;return n===3?Uint8Array.from(statusFault?[0,0,0]:bytes(0)):n===6?Buffer.alloc(6):Buffer.alloc(0);}},async()=>{});
  await assert.rejects(sensor.initialize(signal()),/checksum/);const count=calls;await assert.rejects(sensor.sample(signal()),/checksum/);assert.equal(calls,count);assert.equal(calls,statusFault?3:5);
 }
});
test('SHT3X cancellation after reset prevents later setup writes',async()=>{
 const abort=new AbortController();let calls=0;const sensor=new Sht3xSensor({async transfer(){calls++;return Buffer.alloc(0);}},async()=>{abort.abort(new Error('cancel'));});
 await assert.rejects(sensor.initialize(abort.signal),/cancel/);assert.equal(calls,1);await assert.rejects(sensor.sample(signal()),/cancel/);
});

test('SHT3X forced FETCH waits for a new periodic result and cancellation prevents IO',async()=>{
 let time=0,last=-Infinity,fetches=0;const abort=new AbortController(),waits:number[]=[];
 const sensor=new Sht3xSensor({async transfer(_data,n){
  if(n===6){assert.ok(time-last>=500,'premature FETCH would NACK');last=time;fetches++;return frame(20000,33579);}
  return n===3?Uint8Array.from(bytes(0)):Buffer.alloc(0);
 }},async(ms,signal)=>{waits.push(ms);time+=ms;if(fetches===3)abort.abort(new Error('cancel waiting'));signal.throwIfAborted();},()=>time);
 await sensor.initialize(abort.signal);await sensor.sample(abort.signal);assert.equal(waits.at(-1),1000);
 time+=1100;const count=waits.length;await sensor.sample(abort.signal);assert.equal(waits.length,count);
 await assert.rejects(sensor.sample(abort.signal),/cancel waiting/);assert.equal(fetches,3);
});
