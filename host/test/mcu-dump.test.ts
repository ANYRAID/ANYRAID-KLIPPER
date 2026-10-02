import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {mcuDumpPlan,mcuDumpChunks,dumpMcuToFile,serialMcuDumpReader} from '../src/diagnostics/mcu-dump.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
async function collect(reader:Parameters<typeof mcuDumpChunks>[0],start:number,length:number){const chunks=[];for await(const chunk of mcuDumpChunks(reader,{start,length},signal()))chunks.push(chunk);return Buffer.concat(chunks);}
test('MCU dump alignment and uint32 address boundaries preserve every byte',async()=>{
 for(let start=0;start<8;start++)for(let length=1;length<=16;length++){
  const {order,width}=mcuDumpPlan({start,length});assert.equal(order,[2,0,1,0][(start|length)&3]);let calls=0;
  const bytes=await collect(async(o,a)=>{calls++;assert.equal(o,order);assert.equal(a%width,0);let value=0;for(let b=0;b<width;b++)value+=(a+b)%256*2**(8*b);return value;},start,length);
  assert.deepEqual(bytes,Buffer.from(Array.from({length},(_,i)=>start+i)));assert.equal(calls,length/width);
 }
 assert.deepEqual(await collect(async(_o,a)=>{assert.equal(a,0xffffffff);return 0xffffffff;},0xffffffff,1),Buffer.of(255));
 assert.deepEqual(await collect(async()=>0xffffffff,0xfffffffc,4),Buffer.alloc(4,255));
 assert.equal(mcuDumpPlan({start:0,length:0x100000000}).width,4);
 for(const range of [{start:-1,length:1},{start:0xffffffff,length:2},{start:0,length:0},{start:0.5,length:1},{start:0,length:NaN}])assert.throws(()=>mcuDumpPlan(range));
});
test('MCU dump uses bounded independent chunks and rejects malformed responses or cancellation',async()=>{
 const chunks=[];for await(const chunk of mcuDumpChunks(async()=>0xdeadbeef,{start:0,length:65540},signal()))chunks.push(chunk);assert.deepEqual(chunks.map(c=>c.length),[65536,4]);assert.deepEqual(chunks[0].subarray(0,4),Buffer.from('efbeadde','hex'));chunks[1].fill(0);assert.equal(chunks[0][0],239);
 for(const value of [-1,0x100000000,NaN,1.5,undefined])await assert.rejects(collect(async()=>value as number,0,4),/uint32/);
 const control=new AbortController();let calls=0;await assert.rejects(async()=>{for await(const _chunk of mcuDumpChunks(async()=>{calls++;control.abort(new Error('stop dump'));return 1;},{start:0,length:8},control.signal))assert.fail('must not yield after abort');},/stop dump/);assert.equal(calls,1);
});
test('MCU dump atomically replaces complete files and preserves existing output on failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mcu-dump-')),file=join(dir,'flash.bin');
 try{await writeFile(file,'old');let calls=0;await assert.rejects(dumpMcuToFile(async()=>{if(++calls===16385)throw new Error('read fault');return 0xffffffff;},{start:0,length:65540},file,signal()),/read fault/);assert.equal(await readFile(file,'utf8'),'old');assert.deepEqual(await readdir(dir),['flash.bin']);await dumpMcuToFile(async()=>0x12345678,{start:0,length:8},file,signal());assert.deepEqual(await readFile(file),Buffer.from('7856341278563412','hex'));}finally{await rm(dir,{recursive:true,force:true});}
});
test('MCU dump uses actual dictionary encoding, serial ACKs and uint32 responses',async()=>{
 const requests:{order:number;address:number}[]=[];const firmware=await serialFirmware(undefined,{debugRead(order,address){requests.push({order,address});return 0xfedcba98;}}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());const reader=serialMcuDumpReader(session);assert.deepEqual(await collect(reader,0xfffffff8,8),Buffer.from('98badcfe98badcfe','hex'));assert.deepEqual(requests,[{order:2,address:0xfffffff8},{order:2,address:0xfffffffc}]);assert.equal(session.status.pendingAcks,0);assert.equal(session.status.configured,false);}finally{await session.stop();await firmware.close();}
});
