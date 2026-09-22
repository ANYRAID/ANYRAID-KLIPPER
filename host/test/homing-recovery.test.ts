import {recoveryFixture as fixture} from './helpers/homing-recovery.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {HomingRecovery} from '../src/homing/recovery.ts';
const signal=()=>new AbortController().signal;
test('recovery confirms stop and retires routes before rebuilding and resetting every MCU',async()=>{
 const f=await fixture();try{const recovery=new HomingRecovery(f.options),pending=recovery.recover(signal());assert.strictEqual(recovery.recover(signal()),pending);const result=await pending;
  try{assert.deepEqual(result.motion.bindings.map(b=>b.stepper.flush().position),[100n,101n]);assert.equal(f.stops,0);assert.equal(f.releases,1);assert.equal(f.options.coordinator.status.retired,true);
   for(const fw of f.fs){const names=fw.outputs.map(o=>o.name);assert(names.indexOf('reset_step_clock')>names.indexOf('stepper_get_position'));assert.equal(names.filter(n=>n==='reset_step_clock').length,1);assert.equal(fw.motion.length,0);}
   for(const b of f.options.bindings)assert.throws(()=>b.stepper.generate(1),/closed/);
  }finally{result.motion.dispose();}
 }finally{await f.close();}
});
test('readback or coordinate failure never resets any stepper and stops every member',async()=>{
 for(const bad of ['readback','coordinate']){const f=await fixture();try{if(bad==='readback')f.fs[1].setTriggerReason(4);else f.options.locate=()=>{throw new Error('coordinate failed');};await assert.rejects(new HomingRecovery(f.options).recover(signal()));assert.equal(f.stops,2);for(const fw of f.fs)assert(!fw.outputs.some(o=>o.name==='reset_step_clock'));}finally{await f.close();}}
});
test('a partial reset failure shuts down the complete group and publishes no replacement',async()=>{
 const f=await fixture();try{
  const decoder=new FrameDecoder();let firstReset=false;
  f.fs[0].peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of f.fs[0].dictionary.parseFrame(frame))if(command.name==='reset_step_clock'){firstReset=true;void f.sessions[1].stop(new Error('disconnect during reset'));}});
  await assert.rejects(new HomingRecovery(f.options).recover(signal()));assert(firstReset);assert.equal(f.stops,2);
 }finally{await f.close();}
});
test('preflight rejects incomplete or foreign coordinator bindings without I/O',async()=>{
 const f=await fixture();try{const before=f.fs.map(fw=>fw.outputs.length);assert.throws(()=>new HomingRecovery({...f.options,emitters:f.options.emitters.slice(0,1)}),/ownership/);assert.throws(()=>new HomingRecovery({...f.options,bindings:[{...f.options.bindings[0],id:'wrong'},f.options.bindings[1]]}),/ownership/);assert.equal(f.stops,0);assert.deepEqual(f.fs.map(fw=>fw.outputs.length),before);}finally{await f.close();}
});
test('expired rebuilt baseline and completion timeout fail without publishing usable motion',async()=>{
 for(const fault of ['expired','timeout']){const f=await fixture(1);try{
  if(fault==='expired')f.options.locate=()=>({queues:[{id:'xyz',position:[10,0,0]}],printTime:Number(f.sessions[0].clock.sync.getClock(serialClock.now()))/1e6});
  else {f.options.timeoutMs=30;f.fs[0].ignore('trsync_trigger');}
  await assert.rejects(new HomingRecovery(f.options).recover(signal()),/expired|timed out/);assert.equal(f.stops,1);
  if(fault==='timeout')assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));
 }finally{await f.close();}}
});
