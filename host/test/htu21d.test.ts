import test from 'node:test';
import assert from 'node:assert/strict';
import {htuCrc,decodeHtu21d,Htu21dSensor,htuModels,htuResolutions} from '../src/thermal/htu21d.ts';
const signal=()=>new AbortController().signal;
function crc(word:number){let c=0;for(const byte of [word>>>8,word&255]){c^=byte;for(let bit=0;bit<8;bit++)c=c&128?(c<<1)^49:c<<1;c&=255;}return c;}
const frame=(n:number)=>Uint8Array.of(n>>>8,n&255,crc(n));
test('HTU CRC exhaustive oracle, all payload single-bit corruptions and exact scaling',()=>{
 for(let n=0;n<65536;n++)assert.equal(htuCrc(n),crc(n));
 for(let t=0;t<65536;t+=4){const h=(65532-t)|2,temperature=175.72*t/65536-46.85,humidity=125*(h&65532)/65536-6;for(const model of htuModels){const compensated=humidity+(model==='HTU21D'&&temperature>=0&&temperature<=80?(25-temperature)*-.15:0);assert.deepEqual(decodeHtu21d(frame(t),frame(h),model),{temperature,humidity:Math.max(0,Math.min(100,compensated))});}}
 for(let bit=0;bit<48;bit++){const t=frame(28000),h=frame(30002),f=bit<24?t:h,k=bit%24;f[k>>>3]^=1<<(k&7);assert.throws(()=>decodeHtu21d(t,h,'HTU21D'),/checksum/);}
 assert.throws(()=>decodeHtu21d(frame(28002),frame(30002),'SI7021'),/type/);
});
test('all five HTU family models, four resolutions and both bus modes configure and publish complete samples',async()=>{
 for(const model of htuModels)for(const resolution of Object.keys(htuResolutions) as (keyof typeof htuResolutions)[])for(const hold of [false,true]){
  let reg=2,pending=0,otp=0;const commands:number[][]=[];
  const sensor=new Htu21dSensor({async transfer(data,n){commands.push([...data]);if(data[0]===252)return frame(0x3200);if(data[0]===231)return Uint8Array.of(reg);if(data[0]===230){reg=data[1];if(!(reg&2))otp++;return Buffer.alloc(0);}if([227,229,243,245].includes(data[0])){pending=data[0]===227||data[0]===243?28000:30002;if(model==='SHT21'&&!hold){assert.equal(reg&2,0);reg=2;}}return n===3?frame(pending):Buffer.alloc(0);}},model,{resolution,hold},async()=>{});
  assert.deepEqual(await sensor.initialize(signal()),decodeHtu21d(frame(28000),frame(30002),model));assert(commands.some(c=>c.length===2&&c[0]===230&&c[1]===(2|htuResolutions[resolution])));
  await sensor.sample(signal());if(model==='SHT21'&&!hold)assert.equal(otp,4);else assert.equal(otp,0);await assert.rejects(sensor.initialize(signal()),/restart/);
 }
});
test('HTU CRC failure latches without publishing half a measurement and cancellation prevents IO',async()=>{
 let reg=2,reads=0;const sensor=new Htu21dSensor({async transfer(d,n){if(d[0]===252)return frame(0x3200);if(d[0]===231)return Uint8Array.of(reg);if(d[0]===230)reg=d[1];if(n===3){reads++;return Uint8Array.of(0,0,1);}return Buffer.alloc(n);}},'SI7021',{resolution:'TEMP12_HUM08',hold:false},async()=>{});
 await assert.rejects(sensor.initialize(signal()),/checksum/);assert.equal(reads,1);await assert.rejects(sensor.sample(signal()),/checksum/);assert.equal(reads,1);
 const abort=new AbortController();let calls=0;const cancelled=new Htu21dSensor({async transfer(){calls++;return Buffer.alloc(0);}},'HTU21D',{resolution:'TEMP12_HUM08',hold:false},async()=>abort.abort(new Error('cancel')));await assert.rejects(cancelled.initialize(abort.signal),/cancel/);assert.equal(calls,1);
});
test('HTU rejects active internal heater or unconfirmed resolution before measurement',async()=>{
 for(const heater of [false,true]){let measurements=0;const sensor=new Htu21dSensor({async transfer(d,n){if(d[0]===252)return frame(0x3200);if(d[0]===231)return Uint8Array.of(heater?6:2);if([227,229,243,245].includes(d[0]))measurements++;return Buffer.alloc(n);}},'HTU21D',{resolution:'TEMP12_HUM08',hold:false},async()=>{});
  await assert.rejects(sensor.initialize(signal()),heater?/heater/:/resolution/);await assert.rejects(sensor.sample(signal()),heater?/heater/:/resolution/);assert.equal(measurements,0);
 }
});
