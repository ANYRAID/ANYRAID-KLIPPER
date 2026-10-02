import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
test('native byte stream initializes dictionary and clock then serves acknowledged queries',async()=>{
 const firmware=await serialFirmware();let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());assert.equal(session.status.state,'ready');assert.equal(session.dictionary.constant('CLOCK_FREQ'),1e6);session.clock.assertActive();
 const p=await session.query(session.dictionary.encode('echo',{value:42}),'echo_response',signal());assert.equal(p.message.parameters.value,42);assert.ok(p.sentTime>0);assert.ok(p.receiveTime>=p.sentTime);assert.equal(session.status.pendingAcks,0);
 await session.stop();assert.equal(session.clock.sync.active,false);assert.equal(stops,1);await session.stop();assert.equal(stops,1);await assert.rejects(session.query(Uint8Array.of(2),'uptime',signal()),/not ready/);
 }finally{await session.stop();await firmware.close();}
});
test('cancellation during dictionary bootstrap fences native I/O and stops once',async()=>{
 const firmware=await serialFirmware();firmware.ignore('identify');let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}}),abort=new AbortController();
 try{const p=session.initialize(abort.signal);const rejected=assert.rejects(p,/cancel/);await delay(15);abort.abort(new Error('cancel bootstrap'));await rejected;assert.equal(session.status.state,'closed');assert.equal(session.status.pendingAcks,0);assert.equal(stops,1);const before=firmware.frames;await delay(30);assert.equal(firmware.frames,before);
 }finally{await session.stop();await firmware.close();}
});
test('device stop errors survive reentrant shutdown and reject the caller',async()=>{
 const firmware=await serialFirmware();let stops=0;let session:SerialSession;
 session=new SerialSession(firmware.fd,{async stopDevice(){stops++;void session.stop().catch(()=>{});throw new Error('watchdog unavailable');}});
 try{await assert.rejects(session.stop(),/device stop failed/);assert.equal(stops,1);assert.match(String(session.status.stopError),/watchdog/);assert.equal(session.status.pendingAcks,0);await assert.rejects(session.initialize(signal()),/restart/);
 }finally{await firmware.close();}
});
test('lost responses after initialization close the native session and reject outstanding query',async()=>{
 const firmware=await serialFirmware();let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());firmware.ignore('echo');await assert.rejects(session.query(session.dictionary.encode('echo',{value:1}),'echo_response',signal(),{retries:1}),/Unable/);await delay(5);assert.equal(stops,1);assert.equal(session.status.state,'closed');assert.equal(session.status.pendingAcks,0);
 }finally{await session.stop();await firmware.close();}
});
test('EOF from the native receiver closes an initialized session',async()=>{
 const firmware=await serialFirmware();let stopped!:()=>void;const done=new Promise<void>(r=>{stopped=r;});const session=new SerialSession(firmware.fd,{async stopDevice(){stopped();}});
 try{await session.initialize(signal());firmware.peer.destroy();await Promise.race([done,delay(1000).then(()=>{throw new Error('EOF stop not observed');})]);assert.equal(session.status.state,'closed');assert.match(String(session.status.fault),/receive thread/);assert.equal(session.clock.sync.active,false);
 }finally{await session.stop();await firmware.close();}
});
test('abort while awaiting a native ACK rejects initialization promptly',async()=>{
 const firmware=await serialFirmware();firmware.peer.removeAllListeners('data');const session=new SerialSession(firmware.fd,{async stopDevice(){}}),abort=new AbortController();
 try{const p=session.initialize(abort.signal),rejected=assert.rejects(p,/cancel ACK/);await delay(5);abort.abort(new Error('cancel ACK'));await rejected;assert.equal(session.status.pendingAcks,0);assert.equal(session.status.state,'closed');
 }finally{await session.stop();await firmware.close();}
});
test('event-driven receive drains bursts beyond one batch without another wire wake',async()=>{
 const firmware=await serialFirmware();const values:number[]=[];let finish!:()=>void;const done=new Promise<void>(r=>{finish=r;});const session=new SerialSession(firmware.fd,{async stopDevice(){},onMessage(reply){if(reply.message.name==='echo_response'){values.push(reply.message.parameters.value as number);if(values.length===600)finish();}}});
 try{await session.initialize(signal());await session.query(session.dictionary.encode('echo',{value:999}),'echo_response',signal());
 for(let i=0;i<600;i++)firmware.emitEcho(i);await Promise.race([done,delay(1000).then(()=>{throw new Error('Burst drain stalled');})]);assert.deepEqual(values,Array.from({length:600},(_,i)=>i));assert.equal(session.status.state,'ready');
 }finally{await session.stop();await firmware.close();}
});
test('motion binding requires successful firmware configuration and cannot configure twice',async()=>{
 const firmware=await serialFirmware(),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());assert.throws(()=>session.motionTransport(['x']),/configured/);const result=await session.configure({oidCount:4,commands:[],reservedMoves:12},signal());assert.equal(result.moveSlots,500);assert.equal(session.status.configured,true);assert.equal(session.configuration,result);assert.equal(session.motionQueue('mcu',['x'],()=>0n).moveSlots,500);await assert.rejects(session.configure({oidCount:4,commands:[]},signal()),/unconfigured/);
 }finally{await session.stop();await firmware.close();}
});
