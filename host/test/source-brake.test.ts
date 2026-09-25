import test from 'node:test';
import assert from 'node:assert/strict';
import {idleMotionFixture} from './helpers/idle-motion.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
const signal=()=>new AbortController().signal;
test('source braking cancels future pressure changes and preserves retained updates through resume',async()=>{
 async function trace(future:boolean){const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves());f.e.schedulePressureAdvance(1.1,.08);f.e.schedulePressureAdvance(1.6,.1);if(future)f.e.schedulePressureAdvance(1.62,.3);
  await f.source.flushThrough(1.4,signal());const prefix=structuredClone(f.ticks);const stop=await f.source.brakeAt(1.6,signal());assert.deepEqual(f.ticks,prefix);
  await f.source.drain([],signal());assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});
  f.source.resumeAt(3);const q=new LookAheadQueue();q.addBatch(stop.remainder);await f.source.drain(q.flush(),signal());assert.equal(f.stops,0);return {ticks:f.ticks,positions:f.positions,source:f.source.status.position};
 }finally{f.close();}}
 assert.deepEqual(await trace(true),await trace(false));
});
test('pressure-history cancellation failure prevents path replacement and stops every emitter',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves());f.e.schedulePressureAdvance(1.8,.2);await f.source.flushThrough(1.4,signal());const cause=new Error('pressure cancellation failed'),before=f.source.status,queues=[f.xyz.extract(100,0,5),f.equeue.extract(100,0,5)];
  f.e.cancelPressureAdvanceAfter=()=>{throw cause;};await assert.rejects(f.source.brakeAt(1.6,signal()),e=>e===cause);assert.deepEqual([f.xyz.extract(100,0,5),f.equeue.extract(100,0,5)],queues);assert.equal(f.stops,1);assert.equal(f.coordinator.status.failed,true);assert.equal(f.source.status.sourceTime,before.sourceTime);await assert.rejects(f.source.flush(signal()),/failed/);
 }finally{f.close();}
});
function moves(){const q=new LookAheadQueue();q.add(new Move(motionLimits(100,100,5,0),[50,0,0,2],[60,0,0,3],10));return q.flush();}
for(const filtered of [false,true])test(`owned source brakes XYZ/E together and resumes only after drain (filtered=${filtered})`,async()=>{
 const f=idleMotionFixture(filtered);try{
  f.source.startAt(1);const original=moves();f.source.append(original);await f.source.flushThrough(1.4,signal());const prefix=structuredClone(f.ticks),commits=f.commits;
  original[0].endPos[0]=999;original[0].profile!.cruiseV=999;
  const stop=await f.source.brakeAt(1.6,signal());assert(Math.abs(stop.position[0]-56)<1e-12);assert(Math.abs(stop.position[3]-2.6)<1e-12);assert.equal(f.source.status.braking,true);assert.equal(f.source.status.paused,false);assert.equal(f.commits,commits);assert.deepEqual(f.ticks,prefix);
  assert.throws(()=>f.source.validateBatch(stop.remainder),/Drain the braking/);await f.source.drain([],signal());assert.equal(f.source.status.paused,true);assert.equal(f.source.status.braking,false);assert.equal(f.source.status.bufferedMoves,0);assert.deepEqual(f.positions,{x:700n,e:80n});
  f.source.resumeAt(3);const q=new LookAheadQueue();q.addBatch(stop.remainder);await f.source.drain(q.flush(),signal());assert.deepEqual(f.positions,{x:1100n,e:120n});assert.deepEqual(f.source.status.position,[60,0,0,3]);assert.equal(f.stops,0);
 }finally{f.close();}
});
test('second queue rewrite failure stops the whole source without publishing a false endpoint',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves());f.e.schedulePressureAdvance(1.8,.2);await f.source.flushThrough(1.4,signal());const before=f.source.status,commits=f.commits,cause=new Error('E rewrite failed');let changed=false;
  const replace=f.xyz.replaceFuturePlanned.bind(f.xyz);f.xyz.replaceFuturePlanned=(...a)=>{changed=true;return replace(...a);};f.equeue.replaceFuturePlanned=()=>{throw cause;};
  await assert.rejects(f.source.brakeAt(1.6,signal()),e=>e===cause);assert(changed);assert.equal(f.stops,1);assert.equal(f.commits,commits);assert.deepEqual(f.source.status.position,before.position);assert.equal(f.source.status.sourceTime,before.sourceTime);assert.equal(f.source.status.failed,true);assert.equal(f.coordinator.status.failed,true);await assert.rejects(f.source.flush(signal()),/failed/);
  assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});
 }finally{f.close();}
});
test('an anchor inside generated filter dependencies cannot rewrite any source queue',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves());f.e.schedulePressureAdvance(1.8,.2);await f.source.flushThrough(1.4,signal());const before=[f.xyz.extract(100,0,5),f.equeue.extract(100,0,5)];let cancelled=false;f.e.cancelPressureAdvanceAfter=()=>{cancelled=true;};
  await assert.rejects(f.source.brakeAt(f.coordinator.status.generatedTime,signal()),/dependencies/);assert.deepEqual([f.xyz.extract(100,0,5),f.equeue.extract(100,0,5)],before);assert.equal(f.stops,1);
  assert.equal(cancelled,false);assert.throws(()=>f.e.recoveryFilters(),/settle/);
 }finally{f.close();}
});
test('zero-velocity anchor replaces future motion with stationary coverage for both routes',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);f.source.append(moves());const stop=await f.source.brakeAt(1,signal());assert.equal(stop.brake.length,0);assert.equal(stop.remainder.length,1);await f.source.drain([],signal());assert.deepEqual(f.positions,{x:100n,e:20n});assert.equal(f.ticks.x.length+f.ticks.e.length,0);assert.equal(f.stops,0);}finally{f.close();}
});
test('brake ownership excludes concurrent producers and cancellation cannot publish a late endpoint',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(moves());const before=f.source.status,cancel=new AbortController(),pending=f.source.brakeAt(1.6,cancel.signal),rejected=assert.rejects(pending,/cancel braking/);
  assert.throws(()=>f.source.append([]),/busy/);const busy=assert.rejects(f.source.brakeAt(1.7,signal()),/busy/);cancel.abort(new Error('cancel braking'));await Promise.all([busy,rejected]);
  assert.equal(f.source.status.failed,true);assert.deepEqual(f.source.status.position,before.position);assert.equal(f.source.status.sourceTime,before.sourceTime);assert.equal(f.stops,1);assert.equal(f.commits,0);
 }finally{f.close();}
});
