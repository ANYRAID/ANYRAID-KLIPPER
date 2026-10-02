import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {serialPair} from './helpers/serial-pair.ts';
import {NativeSerialQueue,serialClock} from '../src/protocol/serial-queue.ts';
import {TriggerSyncProtocol,trsyncFormats} from '../src/inputs/trsync.ts';
import {MessageDictionary} from '../src/protocol/dictionary.ts';
import {FrameDecoder,encodeFrame} from '../src/protocol/codec.ts';
const dictionary=new MessageDictionary();dictionary.identify(Buffer.from(JSON.stringify({commands:{[trsyncFormats.config]:2,[trsyncFormats.start]:3,[trsyncFormats.timeout]:4,[trsyncFormats.trigger]:5,[trsyncFormats.stepper]:6},responses:{[trsyncFormats.state]:7},config:{CLOCK_FREQ:1000000}})),false);
const protocol=new TriggerSyncProtocol(dictionary,8);
async function fixture(){const pair=await serialPair(),queue=new NativeSerialQueue(pair.fd),decoder=new FrameDecoder(),messages:ReturnType<MessageDictionary['parseFrame']>=[];
 pair.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk)){messages.push(...dictionary.parseFrame(frame));pair.peer.write(encodeFrame((frame[1]+1)&15,new Uint8Array()));}});
 queue.setClockEstimate({frequency:1e6,sampleTime:serialClock.now(),clock:1000000n});
 return {pair,queue,messages,binding:{queue,commandQueue:3,oid:8,tags:protocol.tags,plan:protocol.start(1000000n,[1,2],.25)},async close(){queue.close();await pair.close();}};
}
async function until(f:()=>boolean){const end=performance.now()+3000;while(!f()){if(performance.now()>end)throw new Error('Trigger fixture timeout');await delay(1);}}
function report(can:number,reason:number,clock:number,oid=8){return encodeFrame(1,dictionary.encode('trsync_state',{oid,can_trigger:can,trigger_reason:reason,clock}));}
test('native trigger fanout runs while the JavaScript event loop is blocked',async()=>{
 const a=await fixture(),b=await fixture();const group=NativeSerialQueue.createTriggerDispatch([a.binding,b.binding]);
 try{group.start();assert.throws(()=>group.start(),/already/);a.pair.peer.write(report(0,1,1000100));
  const sleeper=new Int32Array(new SharedArrayBuffer(4)),end=performance.now()+1000;
  while(performance.now()<end&&![a,b].every(f=>/bytes_write=[1-9]/.test(f.queue.stats)))Atomics.wait(sleeper,0,0,5);
  assert.ok([a,b].every(f=>/bytes_write=[1-9]/.test(f.queue.stats)),'native threads must send before Node resumes');
  assert.equal(a.messages.length,0);assert.equal(b.messages.length,0);
  await until(()=>a.messages.length>0&&b.messages.length>0);
  for(const f of [a,b]){assert.equal(f.messages[0].name,'trsync_trigger');assert.equal(f.messages[0].parameters.reason,2);}
 }finally{group.close();group.close();await a.close();await b.close();}
});
test('native single-MCU live reports extend timeout and ignore unrelated OIDs',async()=>{
 const f=await fixture(),group=NativeSerialQueue.createTriggerDispatch([f.binding]);
 try{group.start();f.pair.peer.write(report(1,0,1100000,9));await delay(20);assert.equal(f.messages.length,0);
  f.pair.peer.write(report(1,0,1100000));await until(()=>f.messages.some(m=>m.name==='trsync_set_timeout'));
  assert.equal(f.messages[0].parameters.clock,1350000);
 }finally{group.close();await f.close();}
});
test('member close invalidates the whole group before freeing queue storage',async()=>{
 const a=await fixture(),b=await fixture(),group=NativeSerialQueue.createTriggerDispatch([a.binding,b.binding]);
 try{group.start();a.queue.close();assert.throws(()=>group.start(),/closed/);group.close();
  const replacement=NativeSerialQueue.createTriggerDispatch([b.binding]);replacement.start();replacement.close();
 }finally{group.close();await a.close();await b.close();}
});
test('native binding rejects duplicate ownership, precision loss and unsynchronized queues',async()=>{
 const f=await fixture();let group:ReturnType<typeof NativeSerialQueue.createTriggerDispatch>|undefined;
 try{
  assert.throws(()=>NativeSerialQueue.createTriggerDispatch([f.binding,f.binding]),/Duplicate/);
  assert.throws(()=>NativeSerialQueue.createTriggerDispatch([{...f.binding,plan:protocol.start(1n<<54n,[1],.25)}]),/precision/);
  assert.throws(()=>NativeSerialQueue.createTriggerDispatch([{...f.binding,commandQueue:128}]),/configuration/);
  group=NativeSerialQueue.createTriggerDispatch([f.binding]);assert.throws(()=>NativeSerialQueue.createTriggerDispatch([f.binding]),/already registered/);
  group.close();group=undefined;
  const p=await serialPair(),q=new NativeSerialQueue(p.fd);try{assert.throws(()=>NativeSerialQueue.createTriggerDispatch([{...f.binding,queue:q}]),/synchronization/);}finally{q.close();await p.close();}
 }finally{group?.close();await f.close();}
});
test('repeated active group teardown releases registrations for later homing',async()=>{
 const f=await fixture();try{for(let i=0;i<100;i++){const group=NativeSerialQueue.createTriggerDispatch([f.binding]);group.start();group.close();}}finally{await f.close();}
});
test('in-flight reports cannot outlive explicit dispatch or queue teardown',async()=>{
 for(let i=0;i<20;i++){
  const f=await fixture(),group=NativeSerialQueue.createTriggerDispatch([f.binding]);
  try{group.start();f.pair.peer.write(report(i%2,i%2?0:1,1100000));
   if(i%2)group.close();else f.queue.close();group.close();
  }finally{await f.close();}
 }
});
test('multi-MCU renewal uses peer progress across distinct clock origins',async()=>{
 const a=await fixture(),b=await fixture();
 const now=serialClock.now();a.queue.setClockEstimate({frequency:1e6,sampleTime:now,clock:1000000n});b.queue.setClockEstimate({frequency:1e6,sampleTime:now,clock:2000000n});
 const group=NativeSerialQueue.createTriggerDispatch([a.binding,{...b.binding,plan:protocol.start(2000000n,[1],.25)}]);
 try{group.start();assert.throws(()=>a.queue.setClockEstimate({frequency:1e6,sampleTime:now,clock:1n<<54n}),/precision/);
  a.pair.peer.write(report(1,0,1100000));await until(()=>b.messages.length>0);
  assert.equal(b.messages[0].name,'trsync_set_timeout');assert.equal(b.messages[0].parameters.clock,2350000);assert.equal(a.messages.length,0);
  b.pair.peer.write(encodeFrame(2,dictionary.encode('trsync_state',{oid:8,can_trigger:1,trigger_reason:0,clock:2100000})));
  await until(()=>a.messages.length>0);assert.equal(a.messages[0].parameters.clock,1350000);
 }finally{group.close();await a.close();await b.close();}
});
test('late live reports never rewind an established timeout or reopen a triggered group',async()=>{
 const f=await fixture(),group=NativeSerialQueue.createTriggerDispatch([f.binding]);
 try{group.start();f.pair.peer.write(report(1,0,1100000));await until(()=>f.messages.length===1);
  assert.equal(f.messages[0].parameters.clock,1350000);
  f.pair.peer.write(encodeFrame(2,dictionary.encode('trsync_state',{oid:8,can_trigger:1,trigger_reason:0,clock:1050000})));
  await delay(120);assert.equal(f.messages.length,1,'stale clock must not enqueue an earlier timeout');
  f.pair.peer.write(encodeFrame(2,dictionary.encode('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:1150000})));
  await until(()=>f.messages.length===2);assert.equal(f.messages[1].name,'trsync_trigger');
  f.pair.peer.write(encodeFrame(3,dictionary.encode('trsync_state',{oid:8,can_trigger:1,trigger_reason:0,clock:1300000})));
  await delay(120);assert.equal(f.messages.length,2,'late live report must not reopen a stopped group');
 }finally{group.close();await f.close();}
});
