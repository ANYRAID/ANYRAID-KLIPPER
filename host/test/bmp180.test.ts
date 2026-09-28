import {waitI2cConversion} from '../src/thermal/i2c-conversion-wait.ts';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {bmp180Fixtures} from '../contracts/bmp180-fixtures.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Bmp180Compensation,bmp180ConversionMs} from '../src/thermal/bmp180.ts';
import {Bme280Sensor} from '../src/thermal/bme280.ts';
import {bmp180Calibration,bmp180Device} from './helpers/bmp180-device.ts';
const signal=()=>new AbortController().signal,options={temperature:2,pressure:2,humidity:2,filter:1};
test('BMP180 big-endian signed calibration preserves floating compensation and input snapshot',()=>{
 const bytes=bmp180Calibration(),c=new Bmp180Compensation(bytes),value=c.decode(27898,23843,0);assert(Math.abs(value.temperature-15)<.1);assert(Math.abs(value.pressure-699.64)<.2);assert.equal(c.calibration.MB,-32768);assert.equal(c.calibration.AC4,32741);bytes.fill(0);assert.deepEqual(c.decode(27898,23843,0),value);assert(Object.isFrozen(c.calibration));
 assert.throws(()=>new Bmp180Compensation(bytes),/Empty/);assert.throws(()=>new Bmp180Compensation(bytes.subarray(1)),/Malformed/);
 const bad=bmp180Calibration();bad.writeUInt16BE(0,6);assert.throws(()=>new Bmp180Compensation(bad),/Invalid/);
 for(const args of [[-1,0,0],[0,65536,0],[65536,0,0],[1,2,4],[1,2,.5]])assert.throws(()=>c.decode(args[0],args[1],args[2]));
});
test('BME configuration autodetects BMP180, waits all four maximum conversion times and publishes no humidity',async()=>{
 for(let oss=0;oss<4;oss++){let now=0;const waits:number[]=[],f=bmp180Device(()=>now),c=new Bmp180Compensation(bmp180Calibration()),sensor=new Bme280Sensor({async transfer(b,n){return f.exchange(0,b,n).data;}},{...options,pressure:oss},async ms=>{waits.push(ms);now+=ms;});
 const value=await sensor.initialize(signal());assert.equal(sensor.chipType,'BMP180');assert.deepEqual(value,c.decode(27898,23843*2**oss,oss));assert.equal('humidity' in value,false);assert.deepEqual(waits,[500,4.5,bmp180ConversionMs(oss)]);
 f.state.rawTemperature=30000;assert.deepEqual(await sensor.sample(signal()),c.decode(30000,23843*2**oss,oss));assert.equal(f.state.reads,4);assert.equal(f.state.conversions,4);
 }
});
test('BMP180 failures latch without partial pair publication; cancellation prevents pressure conversion',async()=>{
 for(const mode of ['stuck','ignored','nack','cancel']){let now=0;const f=bmp180Device(()=>now),abort=new AbortController();const sensor=new Bme280Sensor({async transfer(b,n){if(f.state.fault)throw Error('NACK');const result=f.exchange(0,b,n).data;if(mode==='cancel'&&b[0]===246&&n===2)abort.abort(Error('cancel'));return result;}},options,async ms=>{now+=ms;});
 if(mode==='stuck')f.state.stuck=true;if(mode==='ignored')f.state.ignoreWrites=true;if(mode==='nack')f.state.fault=true;
 await assert.rejects(sensor.initialize(abort.signal));const reads=f.state.reads;await assert.rejects(sensor.sample(signal()));assert.equal(f.state.reads,reads);if(mode==='cancel')assert.equal(f.state.conversions,1);
 }
 for(const pressure of [4,5]){const f=bmp180Device();const sensor=new Bme280Sensor({async transfer(b,n){return f.exchange(0,b,n).data;}},{...options,pressure});await assert.rejects(sensor.initialize(signal()),/oversampling/);assert.equal(f.state.conversions,0);}
});

test('BMP180 frozen original Python calibration and all 8192 paired readings agree exactly',()=>{
 const fixtures=bmp180Fixtures(),input=JSON.stringify(fixtures.map(f=>({bytes:[...f.bytes],samples:f.samples}))),reference=JSON.parse(gunzipSync(readFileSync(new URL('../contracts/bmp180-reference.json.gz',import.meta.url))).toString());
 assert.equal(createHash('sha256').update(input).digest('hex'),reference.inputSha256);
 for(let i=0;i<fixtures.length;i++){const f=fixtures[i],c=new Bmp180Compensation(f.bytes);assert.deepEqual(c.calibration,reference.calibrations[i]);f.samples.forEach((s,j)=>assert.deepEqual(c.decode(s.t,s.p,s.oss),reference.values[i][j]));}
 const bytes=bmp180Calibration();bytes.writeUInt16BE(32768,8);bytes.writeUInt16BE(0,10);bytes.writeInt16BE(0,20);assert.throws(()=>new Bmp180Compensation(bytes).decode(0,0,0),/temperature divisor/);
});

test('conversion waits recheck the monotonic deadline after an early timer wake',async()=>{
 let now=0,calls=0;await waitI2cConversion(500,signal(),()=>now,async ms=>{calls++;now+=calls===1?ms-.75:ms;});assert.equal(calls,2);assert(now>=500);
 let time=0;const f=bmp180Device(()=>time),sensor=new Bme280Sensor({async transfer(b,n){return f.exchange(0,b,n).data;}},options,async ms=>{time+=ms===500||ms===2?ms:ms-.75;});await sensor.initialize(signal());assert.equal(f.state.reads,2);
 const abort=new AbortController();await assert.rejects(waitI2cConversion(10,abort.signal,()=>0,async()=>abort.abort(Error('cancel'))),/cancel/);
});
