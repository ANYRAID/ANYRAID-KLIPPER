import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeSerialQueue,serialClock} from '../src/protocol/serial-queue.ts';
import {serialPair} from './helpers/serial-pair.ts';
import {FrameDecoder,encodeFrame} from '../src/protocol/codec.ts';
async function until(check:()=>boolean){const end=performance.now()+3000;while(!check()){if(performance.now()>end)throw new Error('Batch fixture timeout');await delay(1);}}
test('bulk queue preserves payload order, independent copies and consecutive ACK identifiers',async()=>{
 const pair=await serialPair(),q=new NativeSerialQueue(pair.fd),decoder=new FrameDecoder(),received:Buffer[]=[];let sequence=1,replays=0;const count=2000,packets=Array.from({length:count},(_,i)=>({data:Uint8Array.from({length:i%59+1},(_,j)=>(i+j)%128),min:0n,req:0n})),expected=Buffer.concat([Buffer.from([9]),...packets.map(p=>Buffer.from(p.data)),Buffer.from([8])]);
 try{pair.peer.on('data',bytes=>{for(const frame of decoder.push(Buffer.from(bytes))){// Match MCU sequence admission. Withhold ACKs until a retransmission occurs
 // so duplicate suppression is exercised rather than depending on host load.
 if((frame[1]&15)===sequence){received.push(Buffer.from(frame.subarray(2,-3)));sequence=(sequence+1)&15;}else replays++;
 if(replays)pair.peer.write(encodeFrame(sequence,new Uint8Array()));}});assert.equal(q.send(Uint8Array.of(9)),1n);assert.equal(q.sendBatch(packets),2n);packets.forEach(p=>p.data.fill(0));assert.equal(q.send(Uint8Array.of(8)),2002n);const ids:bigint[]=[];await until(()=>{let e;while((e=q.pull()))if(e.notifyId)ids.push(e.notifyId);return ids.length===count+2;});assert.ok(replays>0);assert.deepEqual(Buffer.concat(received),expected);assert.deepEqual(ids,Array.from({length:count+2},(_,i)=>BigInt(i+1)));}finally{q.close();await pair.close();}
});
test('invalid trailing packet and capacity rejection consume no notification IDs or partial queue slots',async()=>{
 const pair=await serialPair(),q=new NativeSerialQueue(pair.fd),good={data:Uint8Array.of(3),min:1000000000000n,req:1000000000000n};
 try{assert.throws(()=>q.sendBatch([good,{...good,data:new Uint8Array(60)}]),/Invalid/);assert.throws(()=>q.sendBatch([good,{...good,req:1n<<63n}]),/Invalid/);assert.equal(q.sendBatch(Array.from({length:4095},()=>good)),1n);assert.throws(()=>q.sendBatch([good,good]),/capacity/);assert.equal(q.send(good.data,good.min,good.req),4096n);assert.throws(()=>q.sendBatch([good]),/capacity/);}finally{q.close();await pair.close();}
});
test('expired native batch deadline rejects before acceptance and leaves the next ID available',async()=>{
 const pair=await serialPair(),q=new NativeSerialQueue(pair.fd);try{const packet={data:Uint8Array.of(3),min:1000000000000n,req:1000000000000n};assert.throws(()=>q.sendBatch([packet],0,serialClock.now()-1),/deadline/);assert.equal(q.sendBatch([packet]),1n);}finally{q.close();await pair.close();}
});
test('raw native batch boundary validates packed length, shared memory and identifier overflow',async()=>{
 const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../build/serialqueue.node') as {create(fd:number):object;close(h:object):void;sendBatch(h:object,p:Uint8Array,first:bigint,queue:number,deadline:number):void};const pair=await serialPair(),h=native.create(pair.fd),valid=Buffer.alloc(76);valid.writeBigUInt64LE(1000000000000n,0);valid.writeBigUInt64LE(1000000000000n,8);valid[16]=1;valid[17]=3;
 try{assert.throws(()=>native.sendBatch(h,new Uint8Array(75),1n,0,0),/Invalid/);const bad=Buffer.concat([valid,valid]);bad[76+16]=60;assert.throws(()=>native.sendBatch(h,bad,1n,0,0),/Invalid/);assert.throws(()=>native.sendBatch(h,new Uint8Array(new SharedArrayBuffer(76)),1n,0,0));assert.throws(()=>native.sendBatch(h,Buffer.concat([valid,valid]),(1n<<64n)-1n,0,0),/overflow/);native.sendBatch(h,valid,1n,0,0);assert.throws(()=>native.sendBatch(h,valid,1n,0,0),/Invalid/);}finally{native.close(h);await pair.close();}
});
