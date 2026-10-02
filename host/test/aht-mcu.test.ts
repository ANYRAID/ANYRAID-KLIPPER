import test from 'node:test';
import assert from 'node:assert/strict';
import {AhtSensor} from '../src/thermal/aht.ts';
import {compileI2c} from '../src/protocol/i2c-config.ts';
import {sessionI2c} from '../src/drivers/i2c-mcu.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
test('AHT driver uses native serial I2C with real conversion wait and rejects subsequent bus fault',async()=>{
 const signal=new AbortController().signal;let measureAt=0,fault=false,stops=0;
 const firmware=await serialFirmware(undefined,{i2c(_oid,bytes,n){
  if(bytes[0]===0xac)measureAt=performance.now();
  if(n){assert.equal(n,6);assert(performance.now()-measureAt>=100,'Read before conversion wait');return {data:Uint8Array.of(8,128,0,6,0,0),status:fault?'NACK':'SUCCESS'};}
  return {data:Buffer.alloc(0)};
 }}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{
  await session.initialize(signal);const p=compileI2c(session.dictionary,0,56,'i2c1');await session.configure({oidCount:1,commands:[p.config,p.configureBus]},signal);
  const sensor=new AhtSensor(sessionI2c(session,0),'AHT2X');assert.deepEqual(await sensor.initialize(signal),{temperature:25,humidity:50});
  fault=true;await assert.rejects(sensor.sample(signal),/NACK/);assert.equal(stops,1);assert.equal(session.status.state,'closed');
  const count=firmware.outputs.length;await assert.rejects(sensor.sample(signal),/NACK/);assert.equal(firmware.outputs.length,count);
 }finally{await session.stop();await firmware.close();}
});
