import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {encodeTmcSpi,decodeTmcSpi,TmcSpiChain} from '../src/drivers/tmc-spi.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc-spi-reference.json',import.meta.url),'utf8')),signal=()=>new AbortController().signal;
test('all chain positions and uint32 words match 512 frozen original Python frames',()=>{
 for(const row of reference.rows){assert.deepEqual([...encodeTmcSpi(row.length,row.position,row.register,row.value)],row.write);assert.deepEqual([...encodeTmcSpi(row.length,row.position,row.register)],row.read);const bytes=Buffer.from(row.write);bytes[(row.length-row.position)*5]=0xff;assert.deepEqual(decodeTmcSpi(row.length,row.position,bytes),{spiStatus:255,value:row.value});}
 for(const args of [[0,1,0],[11,1,0],[2,0,0],[2,3,0],[1,1,128],[1,1,0,-1],[1,1,0,2**32]])assert.throws(()=>encodeTmcSpi(args[0],args[1],args[2],args[3]));
 assert.throws(()=>decodeTmcSpi(2,1,Buffer.alloc(5)),/Malformed/);
});
test('whole write verification retries serialize against other chain positions',async()=>{
 const frames:string[]=[],clock:bigint[]=[],waiting=Promise.withResolvers<void>();let attempts=0;
 const chain=new TmcSpiChain({async transfer(before,after,min){frames.push(Buffer.from(before).toString('hex'));clock.push(min);if(before[0]&128){attempts++;if(attempts===1)await waiting.promise;const out=Buffer.from(before);out[0]=0;out.writeUInt32BE(attempts===1?0:0xfedcba98,1);assert.deepEqual([...after],Array(10).fill(0));return out;}return Buffer.from([0,0,0,0,0,15,128,0,0,0]);}},2),a=chain.register(2),b=chain.register(1);
 assert.throws(()=>chain.register(2),/Duplicate/);const write=a.write(16,0xfedcba98,signal(),123n),read=b.readRaw(4,signal());await new Promise(r=>setImmediate(r));assert.equal(frames.length,1);waiting.resolve();await write;assert.deepEqual(await read,{spiStatus:15,value:0x80000000});assert.equal(attempts,2);assert.deepEqual(clock,[123n,123n,0n]);
});
test('five mismatches retire the chain and transport cancellation is not replayed',async()=>{
 let calls=0;const chain=new TmcSpiChain({async transfer(){calls++;return Buffer.alloc(5);}}),device=chain.register();await assert.rejects(device.write(16,1,signal()),/verify/);assert.equal(calls,5);await assert.rejects(device.read(1,signal()));assert.equal(calls,5);
 const abort=new AbortController(),other=new TmcSpiChain({async transfer(){abort.abort(new Error('cancel'));return Buffer.alloc(5);}}).register();await assert.rejects(other.read(1,abort.signal),/cancel/);await assert.rejects(other.read(1,signal()),/cancel/);
});
