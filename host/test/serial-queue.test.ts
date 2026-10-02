import {test} from 'node:test';
import assert from 'node:assert/strict';
import {serialPair} from './helpers/serial-pair.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {NativeSerialQueue,serialClock,type SerialEvent} from '../src/protocol/serial-queue.ts';
import {FrameDecoder,encodeFrame} from '../src/protocol/codec.ts';
async function until(predicate:()=>boolean){const end=performance.now()+3000;while(!predicate()){if(performance.now()>end)throw new Error('Serial fixture timed out');await delay(1);}}
test('native serial thread frames commands and reports response before ACK notification',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd),decoder=new FrameDecoder(),frames:Uint8Array[]=[];
 try{p.peer.on('data',chunk=>{for(const f of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){frames.push(f);p.peer.write(encodeFrame(2,Uint8Array.of(7,42)));p.peer.write(encodeFrame(2,new Uint8Array()));}});
 const before=serialClock.now(),id=q.send(Uint8Array.of(3,5));const events:SerialEvent[]=[];await until(()=>{let e;while((e=q.pull()))events.push(e);return events.some(e=>e.notifyId===id);});
 assert.deepEqual(frames[0],encodeFrame(1,Uint8Array.of(3,5)));assert.equal(events[0].notifyId,0n);assert.deepEqual(Uint8Array.from(events[0].data),encodeFrame(2,Uint8Array.of(7,42)));assert.equal(events[1].notifyId,id);assert.equal(events[1].data.length,0);for(const e of events){assert.ok(e.sentTime>=before);assert.ok(e.receiveTime>=e.sentTime);assert.ok(e.receiveTime<=serialClock.now());}assert.match(q.stats,/bytes_write=/);
 }finally{q.close();await p.close();}
});
test('native retransmission preserves payload and marks response send time ambiguous',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd),decoder=new FrameDecoder();let count=0;const frames:Uint8Array[]=[];
 try{p.peer.on('data',chunk=>{for(const f of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){frames.push(f);if(++count===2){p.peer.write(encodeFrame(2,Uint8Array.of(7)));p.peer.write(encodeFrame(2,new Uint8Array()));}}});const id=q.send(Uint8Array.of(3)),events:SerialEvent[]=[];
 await until(()=>{let e;while((e=q.pull()))events.push(e);return events.some(e=>e.notifyId===id);});assert.deepEqual(frames[0],frames[1]);assert.equal(events.find(e=>e.data.length)!.sentTime,0);assert.match(q.stats,/bytes_retransmit=[1-9]/);
 }finally{q.close();await p.close();}
});
test('native clock release holds future messages without blocking Node',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd);let received=false;
 try{q.setClockEstimate({frequency:1e6,sampleTime:serialClock.now(),clock:1000000n});p.peer.on('data',()=>{received=true;});q.send(Uint8Array.of(3),1300000n,1300000n);await delay(30);assert.equal(received,false);await until(()=>received);
 }finally{q.close();await p.close();}
});
test('native queue validates clocks, payloads and capacity before enqueueing',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd);
 try{assert.throws(()=>q.send(new Uint8Array()),/Invalid/);assert.throws(()=>q.send(new Uint8Array(60)),/Invalid/);assert.throws(()=>q.send(Uint8Array.of(1),-1n),/Invalid/);assert.throws(()=>q.send(Uint8Array.of(1),0n,1n<<63n),/Invalid/);assert.throws(()=>q.send(Uint8Array.of(1),0n,0n,128),/Invalid/);assert.throws(()=>q.configure(-1,64),/Invalid/);assert.throws(()=>q.setClockEstimate({frequency:1,sampleTime:0,clock:1n<<63n}),/Invalid/);
 for(let i=0;i<4096;i++)q.send(Uint8Array.of(1),1000000000000n,1000000000000n);assert.throws(()=>q.send(Uint8Array.of(1)),/capacity/);assert.equal(q.pull(),undefined);
 }finally{q.close();q.close();assert.throws(()=>q.send(Uint8Array.of(1)),/closed/);await p.close();}
});
test('closing native duplicate leaves original descriptor owned by caller',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd);q.close();const q2=new NativeSerialQueue(p.fd);q2.close();await p.close();assert.throws(()=>new NativeSerialQueue(-1),/descriptor/);
});
test('event watcher observes data queued before registration and stops callbacks after close',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd),decoder=new FrameDecoder();let peerSaw=false,calls=0;const events:SerialEvent[]=[];
 try{p.peer.on('data',chunk=>{for(const f of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){peerSaw=true;p.peer.write(encodeFrame((f[1]+1)&15,new Uint8Array()));}});const id=q.send(Uint8Array.of(3));await until(()=>peerSaw);await delay(10);
 q.watch(()=>{calls++;let e;while((e=q.pull()))events.push(e);},error=>{throw error;});assert.throws(()=>q.watch(()=>{},()=>{}),/already/);
 await until(()=>events.some(e=>e.notifyId===id));q.close();const before=calls;await delay(15);assert.equal(calls,before);
 }finally{q.close();await p.close();}
});
test('event callback failure closes the native queue and reaches the error handler',async()=>{
 const p=await serialPair(),q=new NativeSerialQueue(p.fd);let failure:unknown;
 try{q.watch(()=>{throw new Error('consumer failed');},error=>{failure=error;});await until(()=>failure!==undefined);assert.match(String(failure),/consumer failed/);assert.throws(()=>q.pull(),/closed/);
 }finally{q.close();await p.close();}
});
test('repeated watched queue shutdown releases wake descriptors and native threads',async()=>{
 const {readdirSync}=await import('node:fs');
 async function cycle(){const p=await serialPair(),q=new NativeSerialQueue(p.fd);try{await new Promise<void>((resolve,reject)=>{q.watch(resolve,reject);});}finally{q.close();await p.close();await delay(1);}}
 await cycle();const before=readdirSync('/proc/self/fd').length;
 for(let i=0;i<20;i++)await cycle();assert.ok(readdirSync('/proc/self/fd').length<=before,'wake descriptor leak');
});
test('CAN mode rejects invalid client IDs and stream descriptors before creating a queue',async()=>{
 const pair=await serialPair();try{
  for(const id of [0,255,257,768,NaN,Infinity,256.5])assert.throws(()=>new NativeSerialQueue(pair.fd,id),/CAN client ID/);
  assert.throws(()=>new NativeSerialQueue(pair.fd,384),/Classical CAN RAW socket/);
  const queue=new NativeSerialQueue(pair.fd);queue.close();
 }finally{await pair.close();}
});
