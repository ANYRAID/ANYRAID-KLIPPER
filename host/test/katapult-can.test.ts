import test from 'node:test';
import assert from 'node:assert/strict';
import {endianness} from 'node:os';
import {katapultCanAddress,katapultCanPacket,katapultCanPayload,openKatapultCAN,resetKatapultCANNodes} from '../src/diagnostics/katapult-can.ts';
test('Katapult CAN assignment identity and native ABI framing retain all UUID bytes',()=>{
 assert.deepEqual(katapultCanAddress('0xFFFFFFFFFFFF'),{uuid:'ffffffffffff',nodeId:129,clientId:514});assert.equal(katapultCanAddress('1',255).clientId,766);
 for(const [uuid,node] of [['x',129],['1000000000000',129],['1',-1],['1',256],['1',1.5]] as const)assert.throws(()=>katapultCanAddress(uuid,node));
 for(let length=0;length<=8;length++){const bytes=Buffer.from(Array.from({length},(_,i)=>i+248)),packet=katapultCanPacket(0x203,bytes);assert.equal(packet.length,16);assert.deepEqual(katapultCanPayload(packet,0x203),bytes);const flagged=Buffer.from(packet);if(endianness()==='LE')flagged.writeUInt32LE(0x80000203);else flagged.writeUInt32BE(0x80000203);assert.throws(()=>katapultCanPayload(flagged,0x203));}
 assert.throws(()=>katapultCanPacket(0x800,Buffer.alloc(1)));assert.throws(()=>katapultCanPacket(0x202,Buffer.alloc(9)));assert.throws(()=>katapultCanPayload(Buffer.alloc(15),0));const long=Buffer.alloc(16);long[4]=9;assert.throws(()=>katapultCanPayload(long,0));
});
test('Katapult CAN validation and pre-abort occur before native socket acquisition',async()=>{
 await assert.rejects(resetKatapultCANNodes('invalid/name',new AbortController().signal),/interface/);await assert.rejects(resetKatapultCANNodes('can0',AbortSignal.abort(new Error('cancel reset'))),/cancel reset/);
 await assert.rejects(openKatapultCAN('invalid/name','1',{},new AbortController().signal),/interface/);await assert.rejects(openKatapultCAN('can0','bad uuid',{},new AbortController().signal),/identity/);await assert.rejects(openKatapultCAN('can0','1',{},AbortSignal.abort(new Error('cancel'))),/cancel/);
});
