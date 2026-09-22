import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {MotionRetiredError} from '../src/motion/retired.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
async function fixture(){const fw=await serialFirmware();let stops=0;const session=new SerialSession(fw.fd,{async stopDevice(){stops++;}});await session.initialize(signal());await session.configure({oidCount:4,commands:[]},signal());return {fw,session,get stops(){return stops;},async close(){await session.stop();await fw.close();}};}
function packet(s:SerialSession,clock=0n,dir=1){return {id:'x',data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir})),minClock:clock,reqClock:clock};}
test('retirement fences synchronously and permits replacement only after accepted prefix ACK',async()=>{
 const f=await fixture(),s=f.session;
 try{
  const old=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+.15);await old.send([packet(s,future)]);
  const retired=old.retire(signal());assert.strictEqual(old.retire(signal()),retired);
  assert.throws(()=>s.motionTransport(['x']),/unbound/);await assert.rejects(old.send([packet(s)]),MotionRetiredError);
  assert.equal(f.fw.motion.length,0);await retired;assert.equal(f.fw.motion.length,1);assert.equal(s.status.pendingAcks,0);assert.equal(f.stops,0);
  const next=s.motionTransport(['x']);await old.retire(signal());assert.throws(()=>s.motionTransport(['x']),/unbound/);await next.send([packet(s,0n,0)]);await next.retire(signal());
  assert.deepEqual(f.fw.motion.map(m=>m.parameters.dir),[1,0]);assert.equal(s.status.state,'ready');
  await old.retire(signal());const third=s.motionTransport(['x']);await assert.rejects(old.send([packet(s)]),MotionRetiredError);await third.retire(signal());
 }finally{await f.close();}
});
test('retirement releases a backpressured sender and discards only its unaccepted tail',async()=>{
 const f=await fixture(),s=f.session;
 try{
  const old=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+.2);
  const sending=old.send(Array.from({length:5000},()=>packet(s,future))),rejected=assert.rejects(sending,MotionRetiredError);
  assert(s.status.pendingAcks>=3900);const retired=old.retire(signal());await rejected;
  const reply=await s.query(s.dictionary.encode('echo',{value:77}),'echo_response',signal());assert.equal(reply.message.parameters.value,77);
  await retired;assert(f.fw.motion.length>=3900&&f.fw.motion.length<=3968);assert.equal(f.stops,0);assert.equal(s.status.state,'ready');
  await s.motionTransport(['x']).retire(signal());
 }finally{await f.close();}
});
test('aborted retirement closes the session and never opens a replacement generation',async()=>{
 const f=await fixture(),s=f.session;
 try{
  const old=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+10);await old.send([packet(s,future)]);
  const abort=new AbortController(),retired=old.retire(abort.signal),rejected=assert.rejects(retired,/retirement cancelled/);abort.abort(new Error('retirement cancelled'));await rejected;
  assert.equal(f.stops,1);assert.equal(s.status.state,'closed');assert.equal(f.fw.motion.length,0);assert.throws(()=>s.motionTransport(['x']),/unbound/);
 }finally{await f.close();}
});
test('pre-aborted retirement permanently fences the old capability',async()=>{
 const f=await fixture();try{const t=f.session.motionTransport(['x']),p=packet(f.session),abort=new AbortController();abort.abort(new Error('already cancelled'));await assert.rejects(t.retire(abort.signal),/already cancelled/);await assert.rejects(t.send([p]),MotionRetiredError);assert.equal(f.stops,1);}finally{await f.close();}
});
