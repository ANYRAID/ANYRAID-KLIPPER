import test from 'node:test';
import assert from 'node:assert/strict';
import {Bme280Compensation} from '../src/thermal/bme280-compensation.ts';
export function calibration(){const first=Buffer.alloc(26);[27504,26435,-1000,36477,-10685,3024,2855,140,-7,15500,-14600,6000].forEach((v,i)=>first.writeUInt16LE(v&65535,i*2));first[25]=75;return {first,second:Uint8Array.of(106,1,0,20,37,3,30)};}
const measurement=(t:number,p:number,h=30000)=>Uint8Array.of(p>>>12,p>>>4&255,(p&15)<<4,t>>>12,t>>>4&255,(t&15)<<4,h>>>8,h&255);
test('BME280 calibration preserves signed 12-bit nibble packing and immutable input snapshot',()=>{
 const {first,second}=calibration();for(let n=0;n<4096;n++){const other=4095-n;second[3]=n>>>4;second[4]=(n&15)|((other&15)<<4);second[5]=other>>>4;const c=new Bme280Compensation(first,second).calibration;assert.equal(c.H4,n<2048?n:n-4096);assert.equal(c.H5,other<2048?other:other-4096);}
 const c=new Bme280Compensation(first,second),t1=c.calibration.T1;first.fill(0);second.fill(0);assert.equal(c.calibration.T1,t1);assert(Object.isFrozen(c));assert(Object.isFrozen(c.calibration));
});
test('BME280/BMP280 decode shares temperature and pressure but has no invented BMP humidity',()=>{
 const {first,second}=calibration(),bme=new Bme280Compensation(first,second),bmp=new Bme280Compensation(first),raw=measurement(519888,415148),full=bme.decode(raw),simple=bmp.decode(raw.subarray(0,6));
 assert(Math.abs(full.temperature-25.08)<.005);assert(Math.abs(full.pressure-1006.5326677582515)<1e-9);assert.equal(simple.temperature,full.temperature);assert.equal(simple.pressure,full.pressure);assert.equal('humidity' in simple,false);
 assert.equal(bme.decode(measurement(519888,415148,0)).humidity,0);assert.equal(bme.decode(measurement(519888,415148,65535)).humidity,100);
 raw[2]|=15;raw[5]|=15;assert.deepEqual(bme.decode(raw),full);
});
test('BME280 rejects missing calibration or malformed measurements rather than publishing zero pressure',()=>{
 for(const first of [Buffer.alloc(26),Buffer.alloc(26,255),Buffer.alloc(23)])assert.throws(()=>new Bme280Compensation(first),/calibration/);
 const {first,second}=calibration();first.writeUInt16LE(0,6);assert.throws(()=>new Bme280Compensation(first,second),/pressure calibration/);
 const valid=calibration(),c=new Bme280Compensation(valid.first,valid.second);assert.throws(()=>c.decode(Buffer.alloc(6)),/Malformed/);assert.throws(()=>new Bme280Compensation(valid.first,Buffer.alloc(6)),/Malformed/);
});
test('BME280/BMP280 match all frozen original Python calibration and compensation values without Python',async()=>{
 const {readFileSync}=await import('node:fs'),{gunzipSync}=await import('node:zlib'),{createHash}=await import('node:crypto'),{bme280Fixtures}=await import('../contracts/bme280-fixtures.ts');
 const reference=JSON.parse(gunzipSync(readFileSync(new URL('../contracts/bme280-reference.json.gz',import.meta.url))).toString()),fixtures=bme280Fixtures(),input=JSON.stringify(fixtures.map(f=>({first:[...f.first],second:f.second?[...f.second]:null,frames:f.frames.map(b=>[...b])})));
 assert.equal(createHash('sha256').update(input).digest('hex'),reference.inputSha256);assert.equal(reference.calibrations.length,32);assert.equal(reference.values.length,32);
 for(let i=0;i<fixtures.length;i++){const f=fixtures[i],compensation=new Bme280Compensation(f.first,f.second);assert.deepEqual(compensation.calibration,reference.calibrations[i]);assert.equal(reference.values[i].length,64);for(let j=0;j<64;j++)assert.deepEqual(compensation.decode(f.frames[j]),reference.values[i][j]);}
});
