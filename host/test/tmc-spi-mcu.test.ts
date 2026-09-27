import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {compileTmcSpi,sessionTmcSpi,tmcSpiFormats} from '../src/drivers/tmc-spi-mcu.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
const pin=(chip:object)=>({chip,chipName:'mcu',pin:'PA0',invert:0 as const,pullup:0 as const});
test('SPI compiler checks firmware bus names, mode three and CS inactive state',()=>{
 const d=new MessageDictionary(),chip={};d.identify(Buffer.from(JSON.stringify({commands:{[tmcSpiFormats.config]:10,[tmcSpiFormats.bus]:11,[tmcSpiFormats.send]:12,[tmcSpiFormats.transfer]:13},responses:{[tmcSpiFormats.response]:14},enumerations:{pin:{PA0:0},spi_bus:{spi1:0}},config:{}})),false);
 const p=compileTmcSpi(chip,d,0,pin(chip),'spi1');assert.equal(p.select,'config_spi oid=0 pin=PA0 cs_active_high=0');assert.match(p.configureBus,/mode=3 rate=4000000/);
 assert.throws(()=>compileTmcSpi(chip,d,0,pin(chip),'spi2'));assert.throws(()=>compileTmcSpi(chip,d,0,pin({}),'spi1'));assert.throws(()=>compileTmcSpi(chip,d,0,pin(chip),'spi1',99999));
});
test('native SPI FIFO preserves pipeline, scheduled writes, chain positions and unsigned values',async t=>{
 const registers=new Map<number,number>(),events:string[]=[];let latched=Buffer.alloc(10);
 const firmware=await serialFirmware(undefined,{tmcSpi(_oid,frame,read){
  assert.equal(frame.length,10);events.push(read?'query':'preface');const previous=latched;latched=Buffer.alloc(10);
  for(let offset=0;offset<10;offset+=5){const register=frame[offset]&127,key=offset*128+register,value=frame[offset+1]*2**24+frame[offset+2]*65536+frame[offset+3]*256+frame[offset+4];if(frame[offset]&128)registers.set(key,value);latched[offset]=8;latched.writeUInt32BE(registers.get(key)??0,offset+1);}
  return {data:previous};
 }}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const p=compileTmcSpi(session,session.dictionary,0,pin(session),0);await session.configure({oidCount:1,commands:[p.select,p.configureBus]},signal());
  const chain=sessionTmcSpi(session,0,2);assert.equal(sessionTmcSpi(session,0,2),chain);assert.throws(()=>sessionTmcSpi(session,0,1),/length/);const a=chain.register(1),b=chain.register(2);
  const clock=session.clock.sync.getClock(serialClock.now()+.03);await Promise.all([a.write(0x6c,0xfedcba98,signal(),clock),b.write(0x6c,0x80000000,signal())]);assert.equal(await a.read(0x6c,signal()),0xfedcba98);assert.deepEqual(await b.readRaw(0x6c,signal()),{spiStatus:8,value:0x80000000});
  const samples:number[]=[];for(let i=0;i<120;i++){const start=performance.now();assert.equal(await a.read(0x6c,signal()),0xfedcba98);if(i>=20)samples.push(performance.now()-start);}samples.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({scope:'Native SPI FIFO and simulated two-device pipeline, 20 warmups/100 reads, no electrical SPI timing',medianMs:samples[50],p95Ms:samples[94],maxMs:samples[99]}));
  assert(events.every((e,i)=>e===(i%2?'query':'preface')));
 }finally{await session.stop();await firmware.close();}
});
test('missing SPI query response cancels the session once without replaying preface',async()=>{
 let stops=0;const firmware=await serialFirmware(undefined,{tmcSpi(){return {data:Buffer.alloc(5)};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{
  await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const device=sessionTmcSpi(session,0).register();firmware.ignore('spi_transfer');const abort=new AbortController(),pending=device.write(1,1,abort.signal),failed=assert.rejects(pending,/cancel/);await delay(30);abort.abort(new Error('cancel'));await failed;assert.equal(stops,1);assert.equal(session.status.state,'closed');assert.equal(firmware.outputs.filter(e=>e.name==='spi_send').length,1);await assert.rejects(device.read(1,signal()));
 }finally{await session.stop();await firmware.close();}
});
test('malformed SPI query response stops the MCU instead of trusting ACK',async()=>{
 let stops=0;const firmware=await serialFirmware(undefined,{tmcSpi(){return {data:Buffer.alloc(0)};}}),session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());await assert.rejects(sessionTmcSpi(session,0).register().read(1,signal()),/Malformed/);assert.equal(stops,1);assert.equal(session.status.state,'closed');}finally{await session.stop();await firmware.close();}
});
test('maximum chain falls back to ordered packets without exceeding MCU payload size',async()=>{
 const events:string[]=[];let expected=Buffer.alloc(50);
 const firmware=await serialFirmware(undefined,{tmcSpi(_oid,data,read){events.push(read?'query':'preface');assert.equal(data.length,50);if(!read){expected=Buffer.from(data);for(let offset=0;offset<50;offset+=5)expected[offset]=0;}return {data:expected};}}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());await session.configure({oidCount:1,commands:[]},signal());const chain=sessionTmcSpi(session,0,10);await chain.register(10).write(0x6c,0xffffffff,signal());await chain.register(1).write(0x10,0x80000000,signal());assert.deepEqual(events,['preface','query','preface','query']);}finally{await session.stop();await firmware.close();}
});
test('TMC2130 native startup and runtime current adjustment verify complete register values',async()=>{
 const {planTmc2130}=await import('../src/drivers/tmc2130.ts'),{initializeTmc220x}=await import('../src/drivers/tmc220x.ts'),{Tmc220xCurrent}=await import('../src/drivers/tmc220x-current.ts'),{ConfigurationReader}=await import('../src/moonraker/config-reader.ts'),{ConfigurationSource}=await import('../src/moonraker/config-source.ts');
 const registers=new Map<number,number>();let latched=Buffer.alloc(5),writes=0;
 const firmware=await serialFirmware(undefined,{tmcSpi(_oid,frame){const previous=latched,bytes=Buffer.from(frame),reg=bytes[0]&127;if(bytes[0]&128){registers.set(reg,bytes.readUInt32BE(1));writes++;}latched=Buffer.alloc(5);latched.writeUInt32BE(registers.get(reg)??0,1);return {data:previous};}}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{
  await session.initialize(signal());const config=compileTmcSpi(session,session.dictionary,0,pin(session),0);await session.configure({oidCount:1,commands:[config.select,config.configureBus]},signal());const device=sessionTmcSpi(session,0).register();
  const reader=new ConfigurationReader(new ConfigurationSource('/spi.cfg',{'tmc2130 stepper_x':{run_current:'.8',driver_sgt:'-64',driver_mslut0:'4294967295'},stepper_x:{rotation_distance:'40',microsteps:'16'}},[]),null),plan=planTmc2130(reader,'tmc2130 stepper_x');
  await initializeTmc220x(device,plan,signal());assert.equal(writes,plan.registers.length);for(const register of plan.registers)assert.equal(await device.read(register.address,signal()),register.value);
  const current=new Tmc220xCurrent(device,plan,signal(),()=>assert.fail('current fault'));await current.set({run:1.5,hold:.3},signal());assert.equal(writes,plan.registers.length+2);assert.equal((await device.read(0x10,signal()))&0x1f1f,(current.current.irun<<8)|current.current.ihold);
 }finally{await session.stop();await firmware.close();}
});
