import test from 'node:test';
import assert from 'node:assert/strict';
import {flashSDCard} from '../src/diagnostics/sd-flash.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
import {fatDisk} from './helpers/fatfs-disk.ts';
import {sdCRC7} from '../src/diagnostics/sd-card-spi.ts';
const signal=()=>new AbortController().signal;
async function fixture(software=false){
 const disk=fatDisk(),card=new SDCardEmulator();card.image=disk.image;card.csd[9]=7;card.csd[15]=sdCRC7(card.csd.subarray(0,15));
 const firmwares:Awaited<ReturnType<typeof serialFirmware>>[]=[],sessions:SerialSession[]=[],reconnects:boolean[]=[];let stops=0;
 const io={async connect(s:AbortSignal,reconnect:boolean){reconnects.push(reconnect);const fw=await serialFirmware(undefined,{spiSoftware:software?'modern':undefined,reset:'ack',mcu:'stm32f103xe',extendedPins:true,tmcSpi(_oid,data,read){if(read)return {data:card.transferBytes(data,s)};card.sendBytes(data,s);return {data:new Uint8Array()};}});firmwares.push(fw);const session=new SerialSession(fw.fd,{async stopDevice(){stops++;}});sessions.push(session);await session.initialize(s);return session;}};
 return {io,card,sessions,firmwares,reconnects,get stops(){return stops;},async close(){for(const session of sessions)await session.stop();for(const fw of firmwares)await fw.close();}};
}
test('offline workflow uploads once, closes and resets, reconnects and verifies requested dictionary',async t=>{
 const f=await fixture();try{
  // Obtain the simulated target build dictionary without opening an extra session.
  const fw=await serialFirmware(undefined,{reset:'ack',mcu:'stm32f103xe',extendedPins:true,tmcSpi(){return {data:new Uint8Array()};}});const dictionary=fw.dictionary.rawIdentify;await fw.close();
  const start=performance.now(),result=await flashSDCard(f.io,{board:'btt-skr-mini',firmware:Buffer.alloc(4097,23),dictionary},signal());
  assert.equal(result.state,'verified');if(result.state==='verified')assert.equal(result.verification.evidence,'running-dictionary');assert.deepEqual(f.reconnects,[false,true]);assert.equal(f.stops,2);assert(f.sessions.every(s=>s.status.state==='closed'));assert.equal(f.firmwares.flatMap(f=>f.outputs).filter(o=>o.name==='reset').length,2);
  t.diagnostic(JSON.stringify({workflowMs:performance.now()-start,scope:'Two native simulated MCU connections, FAT upload and dictionary verification; no physical reboot'}));
 }finally{await f.close();}
});
test('reconnect failure never retries upload and releases the original connection',async()=>{
 const f=await fixture();try{const connect=f.io.connect;f.io.connect=async(s,reconnect)=>{if(reconnect)throw new Error('device missing');return connect(s,reconnect);};await assert.rejects(flashSDCard(f.io,{board:'btt-skr-mini',firmware:Buffer.alloc(4097,23)},signal()),/device missing/);assert.equal(f.sessions.length,1);assert.equal(f.stops,1);assert(f.card.writes.length>0);}finally{await f.close();}
});
test('invalid images and dictionaries fail before device access',async()=>{
 let calls=0;const io={async connect():Promise<SerialSession>{calls++;throw new Error('Unexpected connection');}};
 for(const firmware of [new Uint8Array(),new Uint8Array(new SharedArrayBuffer(10))])await assert.rejects(flashSDCard(io,{board:'btt-skr-mini',firmware},signal()),/firmware image/);
 await assert.rejects(flashSDCard(io,{board:'btt-skr-mini',firmware:Buffer.alloc(10),dictionary:Buffer.from('{}')},signal()));assert.equal(calls,0);
});
test('verify-only does not upload when the expected bootloader artifact is absent',async()=>{
 const f=await fixture();try{await assert.rejects(flashSDCard(f.io,{board:'btt-skr-mini',firmware:Buffer.alloc(10),verifyOnly:true},signal()));assert.equal(f.card.writes.length,0);assert.equal(f.stops,1);assert.deepEqual(f.reconnects,[false]);}finally{await f.close();}
});
test('cancellation after connecting closes the late session and concurrent operations are rejected',async()=>{
 const f=await fixture(),controller=new AbortController();try{
  const original=f.io.connect;f.io.connect=async(s,reconnect)=>{const session=await original(s,reconnect);controller.abort(new Error('cancelled after connect'));return session;};
  const request={board:'btt-skr-mini',firmware:Buffer.alloc(10)},pending=flashSDCard(f.io,request,controller.signal);await assert.rejects(flashSDCard(f.io,request,signal()),/already active/);await assert.rejects(pending,/cancelled after connect/);assert.equal(f.stops,1);assert.equal(f.card.writes.length,0);
 }finally{await f.close();}
});
test('pre-existing MCU configuration is reset once before mounting the card',async()=>{
 const f=await fixture();try{
  const original=f.io.connect;f.io.connect=async(s,reconnect)=>{const session=await original(s,reconnect);if(!reconnect)await session.configure({oidCount:0,commands:[]},s);return session;};
  await assert.rejects(flashSDCard(f.io,{board:'btt-skr-mini',firmware:Buffer.alloc(10),verifyOnly:true},signal()));assert.deepEqual(f.reconnects,[false,true]);assert.equal(f.stops,2);assert.equal(f.firmwares[0].outputs.filter(o=>o.name==='reset').length,1);assert.equal(f.card.writes.length,0);
 }finally{await f.close();}
});
test('power-cycle board returns uploaded receipt and never reports verified or reconnects',async()=>{
 const f=await fixture(true);try{
  const result=await flashSDCard(f.io,{board:'creality-v4.2.2',firmware:Buffer.alloc(4097,23),timestamp:'20260928120000'},signal());assert.equal(result.state,'power-cycle-required');assert.equal(result.upload?.activationVerified,false);assert.deepEqual(f.reconnects,[false]);assert.equal(f.stops,1);assert.equal(f.firmwares[0].outputs.filter(o=>o.name==='reset').length,0);
 }finally{await f.close();}
});
