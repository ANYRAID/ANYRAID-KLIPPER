import test from 'node:test';
import assert from 'node:assert/strict';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=()=>new AbortController().signal;
for(const reset of ['ack','starting'] as const)test(`offline reset closes native session after ${reset}`,async()=>{
 const firmware=await serialFirmware(undefined,{reset});let stops=0;const session=new SerialSession(firmware.fd,{async stopDevice(){stops++;}});
 try{await session.initialize(signal());const pending=session.resetOffline(signal());await assert.rejects(session.resetOffline(signal()),/not ready/);const result=await pending;assert(result.acknowledged||result.restartObserved);assert.equal(session.status.state,'closed');assert.equal(stops,1);assert.equal(firmware.outputs.filter(o=>o.name==='reset').length,1);await assert.rejects(session.resetOffline(signal()));}finally{await session.stop();await firmware.close();}
});
test('missing reset and cancelled requests leave initialized session untouched',async()=>{
 const firmware=await serialFirmware(),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());await assert.rejects(session.resetOffline(signal()),/Unknown/);assert.equal(session.status.state,'ready');await assert.rejects(session.resetOffline(AbortSignal.abort(new Error('cancelled'))),/cancelled/);assert.equal(session.status.state,'ready');}finally{await session.stop();await firmware.close();}
});
test('reset does not hide independent cleanup failure',async()=>{
 const firmware=await serialFirmware(undefined,{reset:'starting'}),session=new SerialSession(firmware.fd,{async stopDevice(){throw new Error('stop failed');}});
 try{await session.initialize(signal());await assert.rejects(session.resetOffline(signal()),/Serial device stop failed|cleanup failed/);assert.equal(session.status.state,'closed');}finally{await session.stop().catch(()=>{});await firmware.close();}
});
test('motion bindings reject offline reset without sending or closing',async()=>{
 const firmware=await serialFirmware(undefined,{reset:'ack'}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());await session.configure({oidCount:0,commands:[]},signal());session.motionTransport(['x']);await assert.rejects(session.resetOffline(signal()),/without motion/);assert.equal(session.status.state,'ready');assert.equal(firmware.outputs.filter(o=>o.name==='reset').length,0);}finally{await session.stop();await firmware.close();}
});
test('reset fences new motion bindings and queries before yielding',async()=>{
 const firmware=await serialFirmware(undefined,{reset:'ack'}),session=new SerialSession(firmware.fd,{async stopDevice(){}});
 try{await session.initialize(signal());await session.configure({oidCount:0,commands:[]},signal());const pending=session.resetOffline(signal());assert.throws(()=>session.motionTransport(['x']),/ready session/);await assert.rejects(session.query(firmware.dictionary.encode('get_config',{}),'config',signal()),/not ready/);await pending;}finally{await session.stop();await firmware.close();}
});
