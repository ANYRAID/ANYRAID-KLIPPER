import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HomingStopSetConfirmation} from '../src/homing/stop-set.ts';
import {HomingSetRecovery} from '../src/homing/recovery.ts';
import {homingSetPositionOffsets} from '../src/homing/position-offsets.ts';
import {StepHistory} from '../src/motion/step-history.ts';
import {stopSetFixture} from './helpers/homing-stop-set.ts';
const signal=()=>new AbortController().signal;
test('all sampling stops precede global release and group clocks remain independent',async()=>{
 const {f,groups}=await stopSetFixture();let released=0;try{
  const stop=new HomingStopSetConfirmation(groups,()=>{released++;for(const fw of f.fs)assert(fw.outputs.some(o=>o.name==='endstop_home'&&o.parameters.sample_count===0));});
  const pending=stop.finish(signal());assert.strictEqual(stop.finish(signal()),pending);const result=await pending;
  assert.equal(released,1);assert.equal(result.hitClock,null);assert.deepEqual(result.memberOffsets,[0,1]);assert.deepEqual(result.positions.map(p=>[p.member,p.position]),[[0,100n],[1,101n]]);
  assert.deepEqual(result.groups.map(g=>g.hitClock),groups.map(g=>g.sampling.reqClock));assert(Object.isFrozen(result.positions));assert.equal(f.stops,0);assert(!f.fs.some(fw=>fw.outputs.some(m=>m.name==='reset_step_clock')));
 }finally{await f.close();}
});
test('shared MCU keeps distinct OID reasons and missing-hit state without inventing a set clock',async()=>{
 const {f,groups}=await stopSetFixture(true);try{
  f.fs[0].setTriggerReason(3,6);const result=await new HomingStopSetConfirmation(groups,()=>{}).finish(signal());
  assert.deepEqual(result.reasons,[1,3]);assert.equal(result.groups[0].hitClock,groups[0].sampling.reqClock);assert.equal(result.groups[1].hitClock,null);assert.deepEqual(result.positions.map(p=>[p.member,p.oid,p.raw]),[[0,1,100],[1,2,101]]);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('independent results drive one retirement, reconstruction and all clock resets',async()=>{
 const {f,groups}=await stopSetFixture();let calls=0,motion:Awaited<ReturnType<HomingSetRecovery['recover']>>['motion']|undefined;
 try{
  const recovery=new HomingSetRecovery({...f.options,groups,locate:result=>{calls++;assert.equal(result.groups.length,2);for(const fw of f.fs){assert(fw.outputs.some(o=>o.name==='stepper_get_position'));assert(!fw.outputs.some(m=>m.name==='reset_step_clock'));}return f.options.locate(result);}});
  const result=await recovery.recover(signal());motion=result.motion;assert.equal(calls,1);assert.equal(f.options.coordinator.status.retired,true);assert.deepEqual(motion.bindings.map(b=>b.history.status.lastPlannedPosition),[100n,101n]);for(const fw of f.fs)assert.equal(fw.outputs.filter(m=>m.name==='reset_step_clock').length,1);assert.equal(f.stops,0);
 }finally{motion?.dispose();await f.close();}
});
test('invalid member readback stops every group before locate or reset',async()=>{
 const {f,groups}=await stopSetFixture();try{
  f.fs[1].setTriggerReason(4,8);let locate=0;const recovery=new HomingSetRecovery({...f.options,groups,locate:result=>{locate++;return f.options.locate(result);}});
  await assert.rejects(recovery.recover(signal()));assert.equal(locate,0);assert.equal(f.stops,2);for(const fw of f.fs)assert(!fw.outputs.some(m=>m.name==='reset_step_clock'));
 }finally{await f.close();}
});
test('overlapping OIDs fail before writes and cancellation releases once and stops all',async()=>{
 const {f,groups}=await stopSetFixture(true);try{
  const before=f.fs[0].outputs.length;assert.throws(()=>new HomingStopSetConfirmation([groups[0],groups[0]],()=>{}),/overlaps/);assert.equal(f.fs[0].outputs.length,before);
  let released=0;const abort=new AbortController();abort.abort(new Error('cancel all'));await assert.rejects(new HomingStopSetConfirmation(groups,()=>{released++;}).finish(abort.signal),/cancel all/);assert.equal(released,1);assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('position reconstruction uses each independent trigger clock and rejects missing hits',async()=>{
 const {f,groups}=await stopSetFixture(true);try{
  const result=await new HomingStopSetConfirmation(groups,()=>{}).finish(signal());
  const bindings=result.groups.map((g,member)=>{const history=new StepHistory(g.hitClock!-100n,0n);history.append({history:new BigInt64Array([g.hitClock!-99n,g.hitClock!+100n,0n,200n,1n,0n]),position:200n},g.hitClock!+100n);return {member,oid:member+1,history};});
  const offsets=homingSetPositionOffsets(result,bindings,result.groups.map(g=>[g.hitClock!]));assert.deepEqual(offsets.map(o=>[o.member,o.trigger,o.halt,o.overshoot]),[[0,100n,100n,0n],[1,100n,101n,1n]]);
  assert.throws(()=>homingSetPositionOffsets({...result,memberOffsets:[0,0]},bindings,result.groups.map(g=>[g.hitClock!])));
  assert.throws(()=>homingSetPositionOffsets({...result,groups:[result.groups[0],{...result.groups[1],hitClock:null}]},bindings,result.groups.map(g=>[g.hitClock!])),/did not trigger/);
 }finally{await f.close();}
});
test('one failure stops peers immediately even when physical safety cleanup never returns',async()=>{
 let release!:()=>void;const safety=new Promise<void>(r=>{release=r;}),{f,groups}=await stopSetFixture(false,()=>safety);
 try{
  f.fs[0].setTriggerReason(4,8);const stop=new HomingStopSetConfirmation(groups,()=>{},30);await assert.rejects(stop.finish(signal()));assert.equal(f.stops,2);assert.equal(stop.status.cleanupPending,true);
  release();await Promise.all(f.sessions.map(s=>s.stop()));await new Promise<void>(r=>setImmediate(r));assert.equal(stop.status.cleanupPending,false);
 }finally{release();await f.close();}
});
import {HomingTriggerGroup} from '../src/homing/trigger-group.ts';
import {HomingTriggerSet} from '../src/homing/trigger-set.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
test('intentional set release after disabling all sampling permits no-hit recovery without stale completion faults',async()=>{
 const {f,groups}=await stopSetFixture();const armed:HomingTriggerGroup[]=[];let motion:Awaited<ReturnType<HomingSetRecovery['recover']>>['motion']|undefined;
 try{
  const configs=groups.map(g=>{const clock=g.members[0].session.clock.sync.getClock(serialClock.now()+.3),sampling=g.endstop.home({printTime:Number(clock)/1e6,sampleTime:.000015,sampleCount:4,restTime:.001,trsyncOid:g.members[0].trigger.oid},t=>BigInt(Math.round(t*1e6)));armed.push(new HomingTriggerGroup(g.members,0,g.endstop,sampling,[clock],.25));return {...g,sampling};});
  const set=new HomingTriggerSet(armed),recovery=new HomingSetRecovery({...f.options,groups:configs,release:()=>set.release(),locate:r=>f.options.locate(r)});
  await set.arm(signal());for(const fw of f.fs)fw.setTriggerReason(3,8);
  const result=await recovery.recover(signal());motion=result.motion;assert.deepEqual(result.stop.groups.map(g=>g.hitClock),[null,null]);assert.equal(set.status.released,true);assert.equal(f.stops,0);
 }finally{for(const g of armed)g.release();motion?.dispose();await f.close();}
});
import {FrameDecoder} from '../src/protocol/codec.ts';
test('a completed member closing while its peer readback hangs fails promptly with the original cause',async()=>{
 const {f,groups}=await stopSetFixture();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  f.fs[1].ignore('stepper_get_position');const decoder=new FrameDecoder();
  f.fs[0].peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of f.fs[0].dictionary.parseFrame(frame))if(command.name==='stepper_get_position')timer=setTimeout(()=>{void f.sessions[0].stop(new Error('late completed-member disconnect'));},10);});
  await assert.rejects(new HomingStopSetConfirmation(groups,()=>{},500).finish(signal()),/late completed-member disconnect/);assert.equal(f.stops,2);
 }finally{clearTimeout(timer);await f.close();}
});
