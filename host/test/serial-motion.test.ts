import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionOutput} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {encodeFrame} from '../src/protocol/codec.ts';
async function until(check:()=>boolean){const deadline=performance.now()+3000;while(!check()){if(performance.now()>deadline)throw new Error('Motion wire fixture timed out');await delay(1);}}
const signal=()=>new AbortController().signal;
test('native motion generation passes through move slots and serial frames without payload changes',async()=>{
 const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());using q=new TrapQueue();q.appendRaw(new Float64Array([1.8,0,.1,0,0,0,0,1,0,0,10,10,0]));using x=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:8,directionTag:9},'x',.01);
 let retained:readonly MotionOutput[]=[];const sink=new MoveQueueSink([s.motionQueue('mcu',['x'],t=>x.clockAt(t))],async outputs=>{retained=outputs;});
 const coordinator=new MotionCoordinator([{id:'x',queue:q,stepper:x}],sink,16*1024*1024,0,[s.clock]);await coordinator.advance(1.9);
 const expected=retained.flatMap(o=>o.messages.flatMap(p=>s.dictionary.parseFrame(encodeFrame(0,p.data))));await until(()=>fw.motion.length===expected.length&&s.status.pendingAcks===0);
 assert.deepEqual(fw.motion.map(m=>({name:m.name,parameters:{...m.parameters}})),expected.map(m=>({name:m.name,parameters:{...m.parameters}})));assert.equal(fw.motion.filter(m=>m.name==='queue_step').reduce((sum,m)=>sum+(m.parameters.count as number),0),100);assert.equal(coordinator.status.committedTime,1.9);
 }finally{await s.stop();await fw.close();}
});
test('one MCU motion queue preserves cross-emitter order and earliest transmission clocks',async()=>{
 const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x','y']),future=s.clock.sync.getClock(serialClock.now()+.12);const packet=(id:string,oid:number,min:bigint,req:bigint)=>({id,data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid,dir:1})),minClock:min,reqClock:req});
 await transport.send([packet('x',3,future,future),packet('y',4,0n,0n)]);await delay(20);assert.equal(fw.motion.length,0);await until(()=>fw.motion.length===2);assert.deepEqual(fw.motion.map(m=>m.parameters.oid),[3,4]);assert.throws(()=>s.motionTransport(['z']),/unbound/);
 }finally{await s.stop();await fw.close();}
});
test('whole-batch validation rejects bad trailing packets before any motion is enqueued',async()=>{
 const fw=await serialFirmware();let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x']),good={id:'x',data:Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1})),minClock:0n,reqClock:0n};await assert.rejects(transport.send([good,{...good,id:'foreign'}]),/Invalid/);assert.equal(stops,1);assert.equal(s.status.state,'closed');assert.equal(fw.motion.length,0);
 }finally{await s.stop();await fw.close();}
});
test('large motion batches yield for ACK capacity while clock/control queries stay available',async()=>{
 const fw=await serialFirmware(),s=new SerialSession(fw.fd,{async stopDevice(){}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+.15),data=Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1})),packets=Array.from({length:5000},()=>({id:'x',data:Buffer.from(data),minClock:future,reqClock:future}));
 const sent=transport.send(packets);assert.ok(s.status.pendingAcks>=3900);for(const p of packets)p.data.fill(0);
 const response=await s.query(s.dictionary.encode('echo',{value:77}),'echo_response',signal());assert.equal(response.message.parameters.value,77);await sent;await until(()=>fw.motion.length===5000&&s.status.pendingAcks===0);assert.ok(fw.motion.every(m=>m.parameters.oid===3&&m.parameters.dir===1));assert.equal(s.status.state,'ready');
 }finally{await s.stop();await fw.close();}
});
test('shutdown releases a backpressured batch and prevents its unsent tail',async()=>{
 const fw=await serialFirmware();let stops=0;const s=new SerialSession(fw.fd,{async stopDevice(){stops++;}});
 try{await s.initialize(signal());await s.configure({oidCount:4,commands:[]},signal());const transport=s.motionTransport(['x']),future=s.clock.sync.getClock(serialClock.now()+10),data=Buffer.from(s.dictionary.encode('set_next_step_dir',{oid:3,dir:1}));const send=transport.send(Array.from({length:5000},()=>({id:'x',data,minClock:future,reqClock:future})));const failed=assert.rejects(send,/closed/);await s.stop();await failed;assert.equal(stops,1);assert.equal(s.status.pendingAcks,0);assert.equal(fw.motion.length,0);
 }finally{await s.stop();await fw.close();}
});
