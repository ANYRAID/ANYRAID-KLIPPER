import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {compileTmcUart,sessionTmcUart,tmcUartFormats} from '../src/drivers/tmc-uart-mcu.ts';
import {encodeTmcWrite} from '../src/drivers/tmc-uart.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
const pin=(chip:object,name:string,pullup:0|1=0)=>({chip,chipName:'mcu',pin:name,invert:0 as const,pullup});
test('MCU UART config uses firmware pins and AVR baud with strict clock validation',()=>{
 const d=new MessageDictionary(),chip={};
 for(const mcu of ['stm32f4','atmega2560','at90usb1286']){
  d.identify(Buffer.from(JSON.stringify({commands:{[tmcUartFormats.config]:2,[tmcUartFormats.send]:3},responses:{[tmcUartFormats.response]:4},enumerations:{pin:{PA0:0,PA1:1}},config:{CLOCK_FREQ:16000000,MCU:mcu}})),false);
  const p=pin(chip,'PA0',1),plan=compileTmcUart(chip,d,2,p,p);assert.equal(plan.bitTime,mcu==='stm32f4'?400:1777);assert.match(plan.commands[0],/rx_pin=PA0 pull_up=1 tx_pin=PA0/);
  assert.throws(()=>compileTmcUart(chip,d,2,p,pin({},'PA1')),/pins/);
  assert.throws(()=>compileTmcUart(chip,d,255,p,p));
 }
});
test('native serial MCU waits for UART completion before IFCNT and preserves scheduled write order',async()=>{
 let count=255,writes=0,writeFinished=true;const registers=new Map<number,number>();
 const firmware=await serialFirmware(undefined,{tmcUart(_oid,frame,read){
  const byte=(i:number)=>{const off=i*10+1;return ((frame[off>>>3]|(frame[(off>>>3)+1]<<8))>>>(off&7))&255;};const reg=byte(2)&127;
  if(!read){writes++;registers.set(reg,byte(3)*2**24+byte(4)*65536+byte(5)*256+byte(6));count=(count+1)&255;writeFinished=false;setTimeout(()=>{writeFinished=true;},15);return {data:Buffer.alloc(0),delayMs:25};}
  assert.equal(writeFinished,true,'ACK is not UART completion');return {data:encodeTmcWrite(255,reg,reg===2?count:registers.get(reg)??0,true)};
 }});const session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const rx=pin(session,'PA0',1),plan=compileTmcUart(session,session.dictionary,0,rx,rx);await session.configure({oidCount:1,commands:plan.commands},signal());
  const bus=sessionTmcUart(session);assert.equal(sessionTmcUart(session),bus);const device=bus.register(0,0);
  await device.write(16,0xfedcba98,signal());assert.equal(await device.read(16,signal()),0xfedcba98);assert.equal(writes,1);
  const clock=session.clock.sync.getClock(serialClock.now()+.05);
  await device.write(16,0x80000000,signal(),clock);assert.equal(await device.read(16,signal()),0x80000000);
  assert.equal(firmware.outputs.filter(o=>o.name==='config_tmcuart').length,1);
 }finally{await session.stop();await firmware.close();}
});
test('aborting a missing MCU response closes the real session and forbids later register traffic',async()=>{
 const firmware=await serialFirmware(undefined,{tmcUart(){return {data:Buffer.alloc(0)};}});let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{
  await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const device=sessionTmcUart(session).register(0,0);firmware.ignore('tmcuart_send');
  const abort=new AbortController(),failed=assert.rejects(device.read(1,abort.signal),/cancel/);await delay(20);abort.abort(new Error('cancel TMC'));await failed;
  assert.equal(session.status.state,'closed');assert.equal(stops,1);const before=firmware.frames;await assert.rejects(device.read(1,signal()));await delay(20);assert.equal(firmware.frames,before);
 }finally{await session.stop();await firmware.close();}
});
test('missing UART response times out once without resending the MCU command',async()=>{
 const firmware=await serialFirmware(undefined,{tmcUart(){return {data:Buffer.alloc(0),delayMs:6000};}});let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{
  await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const device=sessionTmcUart(session).register(0,0);
  await assert.rejects(device.read(1,signal()),/timed out|deadline/);assert.equal(session.status.state,'closed');assert.equal(stops,1);assert.equal(firmware.outputs.filter(o=>o.name==='tmcuart_send').length,1);
 }finally{await session.stop();await firmware.close();}
});
test('native UART read path reports bounded benchmark samples with exact unsigned values',async t=>{
 const firmware=await serialFirmware(undefined,{tmcUart(_oid,write){
  const register=((write[2]|write[3]<<8)>>>5)&127;return {data:encodeTmcWrite(255,register,0xffffffff,true)};
 }}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const p=pin(session,'PA0');await session.configure({oidCount:1,commands:compileTmcUart(session,session.dictionary,0,p,p).commands},signal());const device=sessionTmcUart(session).register(0,0),samples:number[]=[];
  for(let i=0;i<220;i++){const start=performance.now();assert.equal(await device.read(6,signal()),0xffffffff);if(i>=20)samples.push(performance.now()-start);}
  samples.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scope:'Native serialqueue, dictionary, MCU framing and simulated UART reply; 20 warmups/200 sequential reads; excludes physical bit timing',medianMs:samples[100],p95Ms:samples[189],maxMs:samples[199]}));
 }finally{await session.stop();await firmware.close();}
});
