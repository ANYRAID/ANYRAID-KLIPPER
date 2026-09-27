import test from 'node:test';
import assert from 'node:assert/strict';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {TriggerSyncProtocol} from '../src/inputs/trsync.ts';
import {EndstopProtocol} from '../src/inputs/endstop.ts';
import {HomingStopConfirmation} from '../src/homing/stop-confirmation.ts';
const signal=()=>new AbortController().signal;
async function fixture(safety?:()=>Promise<void>){const fw=await serialFirmware(undefined,{triggerSync:true});let stops=0;const session=new SerialSession(fw.fd,{async stopDevice(){stops++;await safety?.();}});await session.initialize(signal());const trigger=new TriggerSyncProtocol(session.dictionary,8),chip={},endstop=new EndstopProtocol(chip,session.dictionary,7,{chip,chipName:'mcu',pin:'PA0',invert:0,pullup:1});await session.configure({oidCount:9,commands:[...trigger.commands,...endstop.commands]},signal());const queue=session.commandQueue();
 const clock=session.clock.sync.getClock(serialClock.now()),sampling=endstop.home({printTime:Number(clock)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:8},t=>BigInt(Math.trunc(t*1e6)));
 fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(BigInt.asUintN(32,sampling.reqClock+sampling.restTicks))});
 return {fw,session,queue,trigger,endstop,sampling,member:{session,queue,trigger,steppers:[{oid:1,inverted:false},{oid:2,inverted:true}]},get stops(){return stops;},async close(){await session.stop().catch(()=>{});await fw.close();}};
}
test('homing stop confirms every MCU before publishing signed readback and leaves clocks reset-required',async()=>{
 const a=await fixture(),b=await fixture();let released=0;
 try{a.fw.setTriggerReason(1);b.fw.setTriggerReason(2);a.fw.setStepperPosition(1,123);a.fw.setStepperPosition(2,-2147483648);b.fw.setStepperPosition(1,-456);
  const stop=new HomingStopConfirmation([a.member,b.member],0,a.endstop,a.sampling,()=>{released++;});const pending=stop.finish(signal());assert.equal(stop.finish(signal()),pending);const result=await pending;
  assert.equal(released,1);assert.equal(result.hitClock,a.sampling.reqClock);assert.deepEqual(result.reasons,[1,2]);assert.deepEqual(result.positions.map(p=>p.position),[123n,2147483648n,-456n,0n]);assert.ok(Object.isFrozen(result.positions));
  for(const f of [a,b]){const names=f.fw.outputs.map(o=>o.name);assert.ok(names.indexOf('trsync_trigger')<names.indexOf('stepper_get_position'));assert.ok(!names.includes('reset_step_clock'));assert.equal(f.stops,0);}
 }finally{await a.close();await b.close();}
});
test('past-end completion reports no hit instead of granting homing',async()=>{
 const f=await fixture();try{f.fw.setTriggerReason(3);const stop=new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{});const r=await stop.finish(signal());assert.equal(r.hitClock,null);assert.equal(r.positions.length,2);}finally{await f.close();}
});
test('communication failure on any MCU stops every session without publishing positions',async()=>{
 const a=await fixture(),b=await fixture();try{a.fw.setTriggerReason(1);b.fw.setTriggerReason(4);const stop=new HomingStopConfirmation([a.member,b.member],0,a.endstop,a.sampling,()=>{});await assert.rejects(stop.finish(signal()),/confirm homing stop/);assert.equal(a.stops,1);assert.equal(b.stops,1);assert.ok(!a.fw.outputs.some(o=>o.name==='stepper_get_position'));}finally{await a.close();await b.close();}
});
test('still-active endstop, future trigger and malformed positions fail closed',async()=>{
 for(const fault of ['active','future','position'] as const){const f=await fixture();try{f.fw.setTriggerReason(1);if(fault==='active')f.fw.setEndstopState({homing:1,pin_value:1,next_clock:0});if(fault==='future')f.fw.setEndstopState({homing:0,pin_value:1,next_clock:Number(f.sampling.reqClock)+10000000});if(fault==='position')f.fw.setStepperPosition(1,0x80000000);
  const stop=new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{});await assert.rejects(stop.finish(signal()),/sampling|future|position/);assert.equal(f.stops,1);
 }finally{await f.close();}}
});
test('cancellation and response timeout release dispatch and stop all sessions',async()=>{
 for(const cancelled of [true,false]){const f=await fixture();let releases=0;try{f.fw.ignore('trsync_trigger');const stop=new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{releases++;},50),abort=new AbortController();if(cancelled)abort.abort(new Error('user cancel'));await assert.rejects(stop.finish(abort.signal),/cancel|timed out/);assert.equal(f.stops,1);assert.equal(releases,1);assert.equal(stop.status.cleanupPending,false);}finally{await f.close();}}
});
test('unresponsive safety cleanup remains visible after bounded failure',async()=>{
 let release!:()=>void;const safety=new Promise<void>(resolve=>{release=resolve;}),f=await fixture(()=>safety);
 try{const abort=new AbortController();abort.abort(new Error('cancel'));const stop=new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{},25);
  await assert.rejects(stop.finish(abort.signal),AggregateError);assert.equal(stop.status.cleanupPending,true);assert.equal(f.stops,1);
  release();await f.session.stop();await new Promise(r=>setImmediate(r));assert.equal(stop.status.cleanupPending,false);
 }finally{release();await f.close();}
});
test('preflight rejects foreign queues and conflicting OIDs without new I/O',async()=>{
 const a=await fixture(),b=await fixture();try{const before=a.fw.outputs.length;
  assert.throws(()=>new HomingStopConfirmation([{...a.member,queue:b.queue}],0,a.endstop,a.sampling,()=>{}),/owned/);
  assert.throws(()=>new HomingStopConfirmation([{...a.member,steppers:[{oid:8,inverted:false}]}],0,a.endstop,a.sampling,()=>{}),/steppers/);
  assert.equal(a.fw.outputs.length,before);assert.equal(a.stops,0);assert.equal(b.stops,0);
 }finally{await a.close();await b.close();}
});
test('late safety failure stays observable after cleanup timeout',async()=>{
 let fail!:(error:Error)=>void;const safety=new Promise<void>((_,reject)=>{fail=reject;}),f=await fixture(()=>safety);
 try{const abort=new AbortController();abort.abort(new Error('cancel'));const stop=new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{},25);
  await assert.rejects(stop.finish(abort.signal),AggregateError);fail(new Error('late physical stop failed'));await f.session.stop().catch(()=>{});await new Promise(r=>setImmediate(r));
  assert.equal(stop.status.cleanupPending,false);assert.equal(stop.status.cleanupErrors.length,1);
 }finally{fail(new Error('cleanup'));await f.close();}
});
test('a member closing during the final peer readback prevents snapshot publication',async()=>{
 const a=await fixture(),b=await fixture();try{a.fw.setTriggerReason(1);b.fw.setTriggerReason(2);const query=b.session.queryOnQueue.bind(b.session),queryA=a.session.queryOnQueue.bind(a.session);
  let ready!:()=>void;const aComplete=new Promise<void>(resolve=>{ready=resolve;});
  a.session.queryOnQueue=async(...args)=>{const result=await queryA(...args);if(args[2]==='stepper_position'&&args[4]?.oid===2)setImmediate(ready);return result;};
  b.session.queryOnQueue=async(...args)=>{const result=await query(...args);if(args[2]==='stepper_position'&&args[4]?.oid===2){await aComplete;await a.session.stop(new Error('late member disconnect'));}return result;};
  const stop=new HomingStopConfirmation([a.member,b.member],0,a.endstop,a.sampling,()=>{});await assert.rejects(stop.finish(signal()),/not ready/);assert.equal(a.stops,1);assert.equal(b.stops,1);
 }finally{await a.close();await b.close();}
});
test('homing phase sampling sees direction-correct counters and propagates read failure',async()=>{
 const {registerStoppedPositionObserver}=await import('../src/motion/stopped-position-observer.ts'),f=await fixture();let seen:bigint|undefined;
 const detach=registerStoppedPositionObserver(f.session,2,async position=>{seen=position;throw new Error('phase transport lost');});
 try{f.fw.setTriggerReason(1);f.fw.setStepperPosition(2,-2147483648);await assert.rejects(new HomingStopConfirmation([f.member],0,f.endstop,f.sampling,()=>{}).finish(signal()),/phase transport lost/);assert.equal(seen,2147483648n);assert.equal(f.stops,1);}finally{detach();await f.close();}
});
