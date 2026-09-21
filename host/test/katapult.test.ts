import test from 'node:test';
import assert from 'node:assert/strict';
import {flashKatapult,katapultFrame,katapultReply,katapultInfo} from '../src/diagnostics/katapult.ts';
import {katapultSimulator,katapultReference} from '../bench/katapult-reference.ts';
const signal=()=>new AbortController().signal;
test('Katapult complete upload/readback frames and padded SHA match original Python for all block sizes',async()=>{
 const image=Buffer.from(Array.from({length:1003},(_,i)=>i*37&255));
 for(const size of [64,128,256,512]){const sim=katapultSimulator(size),reference=katapultReference(image,size),result=await flashKatapult(image,sim.transport,signal(),{expectedMcu:'stm32f407'});assert.deepEqual(sim.frames.map(f=>f.toString('hex')),reference.frames);assert.equal(result.sha1,reference.sha1);assert.equal(result.blocks,Math.ceil(image.length/size));assert.equal(result.info.software,'test');}
});
test('Katapult rejects bad framing, CRC, ACK and command without consuming invalid payloads',()=>{
 const ack=katapultFrame(0xa0,Buffer.from([0x11,0,0,0]));assert.equal(katapultReply(0x11,ack).length,0);
 for(const offset of [0,1,3,ack.length-4,ack.length-2,ack.length-1]){const copy=Buffer.from(ack);copy[offset]^=1;assert.throws(()=>katapultReply(0x11,copy));}
 for(const code of [0xf1,0xf2,0xf3])assert.throws(()=>katapultReply(0x11,katapultFrame(code,Buffer.from([0x11,0,0,0]))),/acknowledgement/);
 assert.throws(()=>katapultReply(0x12,ack),/wrong command/);assert.throws(()=>katapultFrame(0x12,Buffer.alloc(3)));assert.throws(()=>katapultFrame(0x12,Buffer.alloc(1024)));assert.throws(()=>katapultInfo(Buffer.alloc(12)),/block size/);
});
test('Katapult refuses identity mismatch, address overflow, corrupted readback and uncertain writes with no retry or COMPLETE',async()=>{
 for(const failure of ['mcu','uuid','overflow','write','read','cancel']){
  const sim=katapultSimulator(64,failure==='overflow'?0xffffffe0:0x8004000),exchange=sim.transport.exchange,controller=new AbortController();
  sim.transport.exchange=async(frame,timeout,s)=>{const response=await exchange(frame,timeout,s);if(frame[2]===0x12){if(failure==='write')throw new Error('uncertain write');if(failure==='cancel')controller.abort(new Error('cancel'));}if(frame[2]===0x14&&failure==='read'){const payload=Buffer.from(response.subarray(4,-4));payload[8]^=1;return katapultFrame(0xa0,payload);}return response;};
  await assert.rejects(flashKatapult(Buffer.alloc(71),sim.transport,controller.signal,{expectedMcu:failure==='mcu'?'other':undefined,expectedUuid:failure==='uuid'?'000000000000':undefined}));assert.ok(!sim.frames.some(f=>f[2]===0x15));if(['write','cancel'].includes(failure))assert.equal(sim.frames.filter(f=>f[2]===0x12).length,1);if(['mcu','uuid','overflow'].includes(failure))assert.ok(!sim.frames.some(f=>f[2]===0x12));
 }
});
