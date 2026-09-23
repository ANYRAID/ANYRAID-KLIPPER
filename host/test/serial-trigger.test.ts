import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {TriggerSyncProtocol,trsyncFormats} from '../src/inputs/trsync.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
async function fixture(){const firmware=await serialFirmware(undefined,{triggerSync:true});let stops=0;const unmatched:unknown[]=[];const session=new SerialSession(firmware.fd,{onMessage(response){if(response.message.name==='trsync_state'){unmatched.push(response);if(unmatched.length>8)unmatched.shift();}},async stopDevice(){stops++;}});
 await session.initialize(signal());const protocol=new TriggerSyncProtocol(session.dictionary,8);await session.configure({oidCount:9,commands:protocol.commands,restart:protocol.restart},signal());const queue=session.commandQueue();
 return {firmware,session,protocol,queue,unmatched,get stops(){return stops;},async close(){await session.stop().catch(()=>{});await firmware.close();}};
}
async function until(f:()=>boolean){const end=performance.now()+1500;while(!f()){if(performance.now()>end)throw new Error('Session trigger timeout');await delay(2);}}
test('query stays behind earlier scheduled commands on its owned FIFO',async()=>{
 const f=await fixture();try{
  const clock=f.session.clock.sync.getClock(serialClock.now())+150000n;
  const pending=f.queue.send(f.session.dictionary.encode('trsync_set_timeout',{oid:8,clock:Number(clock)}),clock,clock,signal());
  let resolved=false;const query=f.session.queryOnQueue(f.queue,f.protocol.trigger(2),'trsync_state',signal(),{oid:8}).then(r=>{resolved=true;return r;});
  await delay(20);assert.equal(resolved,false);const response=await query;await pending;
  assert.equal(response.message.parameters.trigger_reason,2);assert.deepEqual(f.firmware.outputs.slice(-2).map(m=>m.name),['trsync_set_timeout','trsync_trigger']);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('scheduled queries share routing ownership and cancellation stops the session',async()=>{
 const f=await fixture();try{
  const detach=f.session.subscribeResponse(trsyncFormats.state,8,{receive(){},closed(){}});
  await assert.rejects(f.session.queryOnQueue(f.queue,f.protocol.trigger(2),'trsync_state',signal(),{oid:8}),/subscribed/);detach();
  f.firmware.ignore('trsync_trigger');const abort=new AbortController();const pending=f.session.queryOnQueue(f.queue,f.protocol.trigger(2),'trsync_state',abort.signal,{oid:8});
  await assert.rejects(f.session.query(f.protocol.trigger(2),'trsync_state',signal(),{oid:8}),/already in use/);
  abort.abort(new Error('cancel homing'));await assert.rejects(pending,/cancel homing/);await until(()=>f.stops===1);assert.equal(f.session.status.state,'closed');
 }finally{await f.close();}
});
test('foreign command queues are rejected without sending and native groups span live sessions',async()=>{
 const a=await fixture(),b=await fixture();let group:ReturnType<typeof SerialSession.createTriggerDispatch>|undefined;
 try{
  await assert.rejects(a.session.queryOnQueue(b.queue,a.protocol.trigger(2),'trsync_state',signal(),{oid:8}),/another session/);
  assert.throws(()=>SerialSession.createTriggerDispatch([{session:a.session,queue:b.queue,protocol:a.protocol,plan:a.protocol.start(1000000n,[1],.025)}]),/owned/);
  group=SerialSession.createTriggerDispatch([a,b].map(f=>({session:f.session,queue:f.queue,protocol:f.protocol,plan:f.protocol.start(f.session.clock.sync.getClock(serialClock.now()),[1],.025)})));group.start();
  a.firmware.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:0});
  await until(()=>[a,b].every(f=>f.firmware.outputs.some(m=>m.name==='trsync_trigger')));
  await a.session.stop(new Error('member disconnected'));assert.throws(()=>group!.start(),/closed/);assert.equal(b.session.status.state,'ready');group.close();
 }finally{group?.close();await a.close();await b.close();}
});
test('consecutive queries keep response provenance newer than their request',async()=>{
 const f=await fixture();try{
  for(let i=0;i<10000;i++){
   const before=serialClock.now(),payload=f.protocol.trigger(2);
   const response=await(i%2?f.session.queryOnQueue(f.queue,payload,'trsync_state',signal(),{oid:8}):f.session.query(payload,'trsync_state',signal(),{oid:8})).catch(cause=>{throw new Error(JSON.stringify({iteration:i,before,now:serialClock.now(),frames:f.firmware.frames,requests:f.firmware.outputs.filter(m=>m.name==='trsync_trigger').length,unmatched:f.unmatched,status:f.session.status}),{cause});});
   assert.ok(response.sentTime===0||response.sentTime>=before,`response predates request ${i}`);
  }
  assert.equal(f.stops,0);
 }finally{await f.close();}
});
