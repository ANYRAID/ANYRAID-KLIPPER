import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SDCardSPI,sdCRC7,sdCRC16,sdCommand,sdCapacity} from '../src/diagnostics/sd-card-spi.ts';
import {SDCardEmulator} from './helpers/sd-card-spi.ts';
const signal=()=>new AbortController().signal;
test('SD CRC and command bytes match frozen original Python references',()=>{
 const reference=JSON.parse(readFileSync(new URL('../contracts/sd-crc-reference.json',import.meta.url),'utf8'));
 for(const sample of reference.samples){const data=Buffer.from(sample.hex,'hex');assert.equal(sdCRC7(data),sample.crc7);assert.equal(sdCRC16(data),sample.crc16);}
 assert.deepEqual([...sdCommand(0,0)],[64,0,0,0,0,149]);assert.deepEqual([...sdCommand(8,0x1aa)],[72,0,0,1,170,135]);
 assert.throws(()=>sdCommand(64,0));assert.throws(()=>sdCommand(1,2**32));
});
for(const high of [false,true])test(`SD ${high?'block':'byte'} addressing initializes, reads, serializes writes and resets`,async()=>{
 const io=new SDCardEmulator(high),card=new SDCardSPI(io),info=await card.initialize(signal());assert.equal(info.version,high?2:1);assert.equal(info.highCapacity,high);assert.equal(info.sectors,4096);assert.equal(info.revision,'1.2');
 info.sectors=0;assert.equal(card.info?.sectors,4096);assert.deepEqual(await card.readSector(2,signal()),io.data);assert.equal(io.commands.at(-1)?.argument,high?2:1024);
 const payload=new Uint8Array([1,2,3]),a=card.writeSector(2,payload,signal());payload.fill(99);const b=card.writeSector(3,new Uint8Array([4]),signal());await Promise.all([a,b]);
 assert.equal(io.writes.length,2);const frame=io.writes[0];assert.deepEqual([...frame.slice(0,5)],[254,1,2,3,0]);assert.equal(frame[513]*256+frame[514],sdCRC16(frame.subarray(1,513)));assert.equal(io.writes[1][1],4);
 await card.deinitialize(signal());assert.equal(card.info,undefined);await assert.rejects(card.readSector(0,signal()),/not initialized/);
});
test('SD rejects write protection and invalid sector before sending a command',async()=>{
 for(const kind of ['protected','range'] as const){const io=new SDCardEmulator(true,kind==='protected'),card=new SDCardSPI(io);await card.initialize(signal());const count=io.commands.length;await assert.rejects(card.writeSector(kind==='range'?4096:0,new Uint8Array(),signal()),kind==='range'?/out of range/:/write protected/);assert.equal(io.commands.length,count);}
});
test('SD invalidates card after corrupt reads, truncated replies, busy writes and failed status',async()=>{
 for(const fault of ['badCRC','shortResponse','busy','rejectStatus'] as const){const io=new SDCardEmulator(),card=new SDCardSPI(io);await card.initialize(signal());io[fault]=true;await assert.rejects(fault==='badCRC'||fault==='shortResponse'?card.readSector(0,signal()):card.writeSector(0,io.data,signal()));assert.equal(card.info,undefined);const count=io.commands.length;await assert.rejects(card.readSector(0,signal()),/not initialized/);assert.equal(io.commands.length,count);}
});
test('SD checks register CRC, capacity type, abort and bounded queue',async()=>{
 const io=new SDCardEmulator();io.csd[0]=128;io.csd[15]=sdCRC7(io.csd.subarray(0,15));assert.throws(()=>sdCapacity(io.csd),/capacity/);io.csd[0]=64;assert.throws(()=>sdCapacity(io.csd),/CRC/);
 const card=new SDCardSPI(new SDCardEmulator());await assert.rejects(card.initialize(AbortSignal.abort(new Error('cancelled'))),/cancelled/);
 const tasks=Array.from({length:9},()=>card.initialize(signal()));const all=await Promise.allSettled(tasks);assert.equal(all.filter(r=>r.status==='fulfilled').length,8);assert.match(String((all[8] as PromiseRejectedResult).reason),/queue full/);
});
test('SD cancellation after an in-flight transfer invalidates queued IO and ignores late bytes',async()=>{
 const io=new SDCardEmulator(),card=new SDCardSPI(io);await card.initialize(signal());
 const transfer=io.transfer.bind(io),entered=Promise.withResolvers<void>(),resume=Promise.withResolvers<void>();
 io.transfer=async(data,signal)=>{entered.resolve();await resume.promise;return transfer(data,new AbortController().signal);};
 const controller=new AbortController(),read=card.readSector(0,controller.signal);await entered.promise;
 const next=card.writeSector(1,new Uint8Array([1]),signal());controller.abort(new Error('cancelled'));resume.resolve();
 await assert.rejects(read,/cancelled/);await assert.rejects(next,/not initialized/);assert.equal(card.info,undefined);assert.equal(io.writes.length,0);
});
test('SD capacity keeps unsigned 32-bit sector counts without truncating large cards',()=>{
 const csd=new Uint8Array(16);csd[0]=64;csd[7]=63;csd[8]=255;csd[9]=255;csd[15]=sdCRC7(csd.subarray(0,15));
 assert.equal(sdCapacity(csd).sectors,2**32);assert.deepEqual([...sdCommand(17,2**32-1)].slice(1,5),[255,255,255,255]);
});
