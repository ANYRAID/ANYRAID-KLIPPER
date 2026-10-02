import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const signal=()=>new AbortController().signal;
async function until(predicate:()=>boolean){const end=performance.now()+1500;while(!predicate()){if(performance.now()>end)throw new Error('Fault fixture timeout');await delay(1);}}
for(const event of ['shutdown','is_shutdown','starting'])test(`firmware ${event} closes the session before application callbacks`,async()=>{
 const fw=await serialFirmware();const seen:string[]=[];let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;},onMessage(r){seen.push(r.message.name);}});
 try{await s.initialize(signal());const query=s.dictionary.encode('get_clock',{});fw.emit(event,event==='starting'?{}:event==='shutdown'?{clock:1234567,static_string_id:'Timer too close'}:{static_string_id:'Command request'});await until(()=>s.status.state==='closed'||seen.includes(event));assert.equal(s.status.state,'closed');await s.stop();assert.equal(stops,1);assert.equal(s.clock.sync.active,false);assert.equal(seen.includes(event),false);assert.match(String(s.status.fault),event==='starting'?/restart/:/shutdown/);await assert.rejects(s.query(query,'clock',signal()),/ready/);
 }finally{await s.stop();await fw.close();}
});
import {FirmwareFault,firmwareFault} from '../src/protocol/firmware-fault.ts';
import {ClockSync} from '../src/timing/clock-sync.ts';
test('fault diagnostics preserve static reasons and nearest 64-bit clock across rollover',()=>{
 const clock=new ClockSync(1e6,0x100000010n,0);
 const fault=firmwareFault({name:'shutdown',parameters:{clock:0xfffffff0,static_string_id:'Timer too close'}},123,clock)!;
 assert.ok(fault instanceof FirmwareFault);assert.deepEqual(fault.details,{event:'shutdown',reason:'Timer too close',receiveTime:123,clock32:0xfffffff0,clock:0xfffffff0n});assert.ok(Object.isFrozen(fault.details));
 assert.equal(firmwareFault({name:'shutdown',parameters:{clock:NaN}},1)?.details.reason,'Unknown MCU shutdown reason');assert.equal(firmwareFault({name:'is_shutdown',parameters:{static_string_id:123}},1)?.details.reason,'MCU reason 123');assert.equal(firmwareFault({name:'clock',parameters:{clock:1}},1),undefined);
});
test('shutdown cannot be consumed as a requested query response',async()=>{
 const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}});
 try{await s.initialize(signal());fw.ignore('echo');const query=s.query(s.dictionary.encode('echo',{value:1}),'shutdown',signal());const rejected=assert.rejects(query,error=>error instanceof FirmwareFault);fw.emit('shutdown',{clock:123,static_string_id:'Timer too close'});await rejected;assert.equal(s.status.state,'closed');assert.ok(s.status.fault instanceof FirmwareFault);assert.equal((s.status.fault as FirmwareFault).details.reason,'Timer too close');
 }finally{await s.stop();await fw.close();}
});
test('shutdown during clock initialization rejects startup without inventing a clock epoch',async()=>{
 const fw=await serialFirmware();fw.ignore('get_uptime');let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});
 try{const start=s.initialize(signal()),rejected=assert.rejects(start,/MCU shutdown/);await until(()=>s.status.state==='warming');fw.emit('shutdown',{clock:42,static_string_id:'Command request'});await rejected;assert.equal(stops,1);const fault=s.status.fault as FirmwareFault;assert.equal(fault.details.clock32,42);assert.equal(fault.details.clock,undefined);assert.equal(s.status.state,'closed');
 }finally{await s.stop();await fw.close();}
});
test('firmware fault cancels backpressured future motion and blocks its unsent tail',async()=>{
 const fw=await serialFirmware();let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+10),data=Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1}));const pending=transport.send(Array.from({length:5000},()=>({id:'x',data,minClock:future,reqClock:future})));const rejected=assert.rejects(pending,/closed/);fw.emit('is_shutdown',{static_string_id:'Timer too close'});await rejected;assert.equal(stops,1);assert.equal(s.status.pendingAcks,0);assert.equal(fw.motion.length,0);assert.equal(s.clock.sync.active,false);assert.ok(s.status.fault instanceof FirmwareFault);
 }finally{await s.stop();await fw.close();}
});
test('shutdown retains the original MCU fault when the device stop callback fails',async()=>{
 const fw=await serialFirmware();let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;throw new Error('watchdog failed');}});
 try{await s.initialize(signal());fw.emit('starting');await until(()=>s.status.state==='closed');await assert.rejects(s.stop(),/device stop failed/);assert.ok(s.status.fault instanceof FirmwareFault);assert.match(String(s.status.stopError),/watchdog failed/);assert.equal(stops,1);
 }finally{await s.stop().catch(()=>{});await fw.close();}
});
