import test from 'node:test';
import assert from 'node:assert/strict';
import {Sht3xSensor,sht3xCrc} from '../src/thermal/sht3x.ts';
import {compileI2c} from '../src/protocol/i2c-config.ts';
import {sessionI2c} from '../src/drivers/i2c-mcu.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
test('SHT3X native serial startup fetches CRC-protected words and retires on NACK',async()=>{
 const signal=new AbortController().signal;let fault=false,periodicAt=0,stops=0;
 const firmware=await serialFirmware(undefined,{i2c(_oid,bytes,n){
  if(bytes[0]===0x22)periodicAt=performance.now();if(n===6){assert.deepEqual([...bytes],[224,0]);assert(performance.now()-periodicAt>=15.5);}
  return {data:n===3?Uint8Array.of(0,0,sht3xCrc(0)):n===6?Uint8Array.of(0,0,sht3xCrc(0),255,255,sht3xCrc(65535)):Buffer.alloc(0),status:fault?'NACK':'SUCCESS'};
 }}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal);const p=compileI2c(session.dictionary,0,68,'i2c1');await session.configure({oidCount:1,commands:[p.config,p.configureBus]},signal);const sensor=new Sht3xSensor(sessionI2c(session,0));
  assert.deepEqual(await sensor.initialize(signal),{temperature:-45,humidity:100});fault=true;await assert.rejects(sensor.sample(signal),/NACK/);assert.equal(stops,1);assert.equal(session.status.state,'closed');
 }finally{await session.stop();await firmware.close();}
});
