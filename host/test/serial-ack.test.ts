import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
async function fixture(){const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}});await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x']);return {fw,s,transport,packet(delaySeconds:number){const clock=s.clock.sync.getClock(serialClock.now()+delaySeconds);return {id:'x',data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1})),minClock:clock,reqClock:clock};},async close(){await s.stop();await fw.close();}};}
test('ACK snapshot completes from receive events and ignores later future commands',async()=>{
 const f=await fixture();try{await f.transport.send([f.packet(.08)]);const completed=f.s.waitForAcknowledgements(signal());await f.transport.send([f.packet(10)]);await completed;assert.equal(f.fw.motion.length,1);assert.equal(f.s.status.pendingAcks,1);assert.equal(f.s.status.state,'ready');}finally{await f.close();}
});
test('newer control ACK cannot prematurely complete an older delayed motion snapshot',async()=>{
 const f=await fixture();try{await f.transport.send([f.packet(.15)]);let done=false;const completed=f.s.waitForAcknowledgements(signal()).then(()=>{done=true;});const response=await f.s.query(f.s.dictionary.encode('echo',{value:17}),'echo_response',signal());assert.equal(response.message.parameters.value,17);assert.equal(done,false);assert.equal(f.fw.motion.length,0);await completed;assert.equal(f.fw.motion.length,1);}finally{await f.close();}
});
test('overlapping snapshots complete independently and cancellation leaves accepted motion alone',async()=>{
 const f=await fixture();try{await f.transport.send([f.packet(.1)]);const abort=new AbortController(),first=f.s.waitForAcknowledgements(signal()),second=f.s.waitForAcknowledgements(abort.signal),rejected=assert.rejects(second,/cancel observation/);abort.abort(new Error('cancel observation'));await rejected;assert.equal(f.s.status.state,'ready');assert.ok(f.s.status.pendingAcks>0);await first;assert.equal(f.fw.motion.length,1);}finally{await f.close();}
});
test('firmware fault rejects pending acknowledgement observations with the original cause',async()=>{
 const f=await fixture();try{await f.transport.send([f.packet(10)]);const wait=f.s.waitForAcknowledgements(signal()),rejected=assert.rejects(wait,/MCU shutdown: Timer too close/);f.fw.emit('is_shutdown',{static_string_id:'Timer too close'});await rejected;assert.equal(f.s.status.state,'closed');assert.equal(f.fw.motion.length,0);}finally{await f.close();}
});
test('ACK observation has bounded listeners and rejects all waits on shutdown',async()=>{
 const f=await fixture();try{await f.transport.send([f.packet(10)]);const waits=Array.from({length:128},()=>assert.rejects(f.s.waitForAcknowledgements(signal()),/stop observers/));await assert.rejects(f.s.waitForAcknowledgements(signal()),/Too many/);await f.s.stop(new Error('stop observers'));await Promise.all(waits);await assert.rejects(f.s.waitForAcknowledgements(signal()),/closed/);}finally{await f.close();}
});
test('an empty snapshot resolves immediately while pre-aborted observations reject',async()=>{
 const f=await fixture();try{await f.s.waitForAcknowledgements(signal());const abort=new AbortController();abort.abort(new Error('already aborted'));await assert.rejects(f.s.waitForAcknowledgements(abort.signal),/already aborted/);await delay(1);assert.equal(f.s.status.state,'ready');}finally{await f.close();}
});
