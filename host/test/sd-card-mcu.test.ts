import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {sessionSDCardSPI} from '../src/diagnostics/sd-card-mcu.ts';
import {compileSpi} from '../src/protocol/spi-config.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
const signal=()=>new AbortController().signal;
async function fixture(){
 const card=new SDCardEmulator();let stops=0;
 const firmware=await serialFirmware(undefined,{tmcSpi(oid,data,read){assert.equal(oid,0);if(read)return {data:card.transferBytes(data,signal())};card.sendBytes(data,signal());return {data:new Uint8Array()};}});
 const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());const plan=compileSpi(session,session.dictionary,0,{chip:session,chipName:'mcu',pin:'PA0',invert:0,pullup:0},'spi1',400000,0);await session.configure({oidCount:1,commands:[plan.select,plan.configureBus]},signal());return {card,firmware,session,get stops(){return stops;},async close(){await session.stop();await firmware.close();}};}catch(error){await session.stop();await firmware.close();throw error;}
}
test('SD sector IO traverses native UART framing and owned MCU SPI FIFO',async t=>{
 const f=await fixture();try{
  const card=sessionSDCardSPI(f.session,0);assert.equal(sessionSDCardSPI(f.session,0),card);assert.throws(()=>sessionSDCardSPI(f.session,255));
  assert.equal((await card.initialize(signal())).sectors,4096);
  const times:number[]=[];
  for(let i=0;i<12;i++){const start=performance.now();assert.deepEqual(await card.readSector(i,signal()),f.card.data);await card.writeSector(i,f.card.data,signal());if(i>=2)times.push(performance.now()-start);}
  assert.equal(f.card.writes.length,12);assert.equal(f.stops,0);assert(f.firmware.outputs.filter(e=>e.name==='spi_send'||e.name==='spi_transfer').every(e=>(e.parameters.data as Uint8Array).length<=32));
  times.sort((a,b)=>a-b);t.diagnostic(JSON.stringify({warmups:2,samples:10,sectorBytes:512,readWriteMedianMs:times[5],readWriteMaxMs:times[9],scope:'Native UART ACK/query path with simulated MCU and card; no physical card latency'}));
  await card.deinitialize(signal());assert.equal(card.info,undefined);
 }finally{await f.close();}
});
test('SD malformed MCU response stops session and rejects subsequent IO',async()=>{
 const f=await fixture();try{const card=sessionSDCardSPI(f.session,0);await card.initialize(signal());f.card.shortResponse=true;await assert.rejects(card.readSector(0,signal()),/Malformed/);assert.equal(f.stops,1);assert.equal(f.session.status.state,'closed');assert.equal(card.info,undefined);await assert.rejects(card.readSector(0,signal()));}finally{await f.close();}
});
test('SD cancelled query stops MCU without replaying the SPI transfer',async()=>{
 const f=await fixture();try{const card=sessionSDCardSPI(f.session,0);await card.initialize(signal());f.firmware.ignore('spi_transfer');const before=f.card.commands.length,controller=new AbortController(),pending=card.readSector(0,controller.signal),rejected=assert.rejects(pending,/cancel/);await delay(30);controller.abort(new Error('cancel'));await rejected;assert.equal(f.stops,1);assert.equal(f.card.commands.length,before+1);assert.equal(card.info,undefined);}finally{await f.close();}
});
