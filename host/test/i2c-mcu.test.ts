import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {compileI2c,compileSoftwareI2c,i2cFormats} from '../src/protocol/i2c-config.ts';
import {sessionI2c} from '../src/drivers/i2c-mcu.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
test('I2C compiler validates bus, address, pin aliases and representable half-period',()=>{
 const d=new MessageDictionary(),chip={},pin=(name:string)=>({chip,chipName:'mcu',pin:name,invert:0 as const,pullup:0 as const});
 d.identify(Buffer.from(JSON.stringify({commands:{[i2cFormats.config]:10,[i2cFormats.bus]:11,[i2cFormats.software]:12,[i2cFormats.transfer]:13},responses:{[i2cFormats.response]:14},enumerations:{pin:{PA0:0,PA1:1,ALIAS:0},i2c_bus:{i2c1:0}},config:{CLOCK_FREQ:72000000}})),false);
 assert.equal(compileI2c(d,0,56,'i2c1').configureBus,'i2c_set_bus oid=0 i2c_bus=i2c1 rate=100000 address=56');
 assert.match(compileSoftwareI2c(chip,d,0,56,pin('PA0'),pin('PA1')).configureBus,/pulse_ticks=360 address=56/);
 assert.throws(()=>compileI2c(d,0,128,'i2c1'));assert.throws(()=>compileI2c(d,0,56,'unknown'));
 assert.throws(()=>compileSoftwareI2c(chip,d,0,56,pin('PA0'),pin('ALIAS')),/identity/);
 assert.throws(()=>compileSoftwareI2c(chip,d,0,56,pin('PA0'),pin('PA1'),72000000),/clock/);
});
test('I2C native FIFO confirms writes, snapshots caller bytes and bounds responses',async t=>{
 const writes:number[][]=[],firmware=await serialFirmware(undefined,{i2c(_oid,write,length){writes.push([...write]);return {data:Uint8Array.from({length},(_,i)=>i),delayMs:writes.length===1?15:undefined};}}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const p=compileI2c(session.dictionary,0,56,'i2c1');await session.configure({oidCount:1,commands:[p.config,p.configureBus]},signal());const device=sessionI2c(session,0);assert.equal(sessionI2c(session,0),device);
  const bytes=Buffer.from([0xac,0x33,0]),a=device.transfer(bytes,0,signal()),b=device.transfer(Buffer.alloc(0),6,signal());bytes.fill(255);
  assert.equal((await a).length,0);assert.deepEqual([...(await b)],[0,1,2,3,4,5]);assert.deepEqual(writes,[[0xac,0x33,0],[]]);
  await assert.rejects(device.transfer(Buffer.alloc(49),0,signal()),/size/);await assert.rejects(device.transfer(Buffer.alloc(0),256,signal()),/size/);assert.equal(writes.length,2);
  assert.equal((await device.transfer(Buffer.alloc(48),48,signal())).length,48);
  const samples:number[]=[];for(let i=0;i<120;i++){const start=performance.now();await device.transfer(Buffer.alloc(0),6,signal());if(i>=20)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);
  t.diagnostic(JSON.stringify({scope:'Node 26 native serial I2C six-byte query; simulated MCU; 20 warmups/100 retained; no electrical or target-board timing',medianMs:samples[50],p95Ms:samples[94],maxMs:samples[99]}));
 }finally{await session.stop();await firmware.close();}
});
test('I2C NACK and malformed responses stop MCU and retire queued transactions',async()=>{
 for(const status of ['NACK','START_NACK','START_READ_NACK','BUS_TIMEOUT','SUCCESS']){
  let calls=0,stops=0;const firmware=await serialFirmware(undefined,{i2c(){calls++;return {status,data:Buffer.alloc(0)};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
  try{await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const device=sessionI2c(session,0);
   const results=await Promise.allSettled([device.transfer(Buffer.alloc(0),6,signal()),device.transfer(Buffer.alloc(0),6,signal())]);assert(results.every(r=>r.status==='rejected'));assert.equal(calls,1);assert.equal(stops,1);assert.equal(session.status.state,'closed');
  }finally{await session.stop();await firmware.close();}
 }
});
test('I2C response loss cancellation stops session without application replay',async()=>{
 let calls=0,stops=0;const firmware=await serialFirmware(undefined,{i2c(){calls++;return {data:Buffer.alloc(6),delayMs:1000};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const abort=new AbortController(),result=assert.rejects(sessionI2c(session,0).transfer(Buffer.alloc(0),6,abort.signal),/cancel/);
  while(calls===0)await delay(1);abort.abort(new Error('cancel'));await result;assert.equal(calls,1);assert.equal(stops,1);
 }finally{await session.stop();await firmware.close();}
});
test('I2C queue is bounded and cancellation before dispatch does not stop MCU',async()=>{
 let calls=0,stops=0;const firmware=await serialFirmware(undefined,{i2c(){calls++;return {data:Buffer.alloc(0),delayMs:calls===1?50:undefined};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const device=sessionI2c(session,0),abort=new AbortController();
  const requests=Array.from({length:64},(_,i)=>device.transfer(Buffer.alloc(0),0,i===63?abort.signal:signal())),settled=Promise.allSettled(requests);
  await assert.rejects(device.transfer(Buffer.alloc(0),0,signal()),/queue full/);abort.abort(new Error('queued cancel'));
  const results=await settled;assert.equal(results.filter(r=>r.status==='fulfilled').length,63);assert.equal(results[63].status,'rejected');assert.equal(calls,63);assert.equal(stops,0);
  await device.transfer(Buffer.alloc(0),0,signal());assert.equal(calls,64);
 }finally{await session.stop();await firmware.close();}
});
