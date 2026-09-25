import test from 'node:test';
import assert from 'node:assert/strict';
import {idleMotionFixture} from './helpers/idle-motion.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markPressureBoundary,pressureBoundarySchedule} from '../src/motion/pressure-boundaries.ts';
import {dwellMove} from '../src/motion/dwell.ts';
import {planPathStop} from '../src/motion/path-stop.ts';
const signal=()=>new AbortController().signal;
test('pressure endpoints follow braking and resumed geometry before native generation',async()=>{
 async function trace(marked:boolean){const f=idleMotionFixture(true);try{
  const q=new LookAheadQueue(),limits=motionLimits(100,100,5,0);q.add(new Move(limits,[50,0,0,2],[50.2,0,0,2.02],10));q.add(new Move(limits,[50.2,0,0,2.02],[60,0,0,3],10));const planned=q.flush();
  if(marked){markPressureBoundary(planned[0],{stepper:'e',advance:.08});markPressureBoundary(planned[1],{stepper:'e',advance:.1});}
  f.source.startAt(1);f.source.append(planned);if(!marked){let t=1;for(const [i,m] of planned.entries()){const p=m.profile!;t=((t+p.accelT)+p.cruiseT)+p.decelT;f.e.schedulePressureAdvance(t,i===0?.08:.1);}}
  // Stop crosses the first endpoint but not the second: the first update
  // belongs to the retimed brake; the second follows the resumed remainder.
  const stop=await f.source.brakeAt(1.06,signal());assert(stop.brake.length>1);if(!marked){const p=stop.brake[0].profile!;f.e.schedulePressureAdvance(((1.06+p.accelT)+p.cruiseT)+p.decelT,.08);}
  await f.source.drain([],signal());assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.08,smoothTime:.04}});
  const resume=new LookAheadQueue();resume.addBatch(stop.remainder);const rest=resume.flush();f.source.resumeAt(3);f.source.append(rest);if(!marked){let t=3;for(const m of rest){const p=m.profile!;t=((t+p.accelT)+p.cruiseT)+p.decelT;}f.e.schedulePressureAdvance(t,.1);}
  await f.source.drain([],signal());assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});return {ticks:f.ticks,positions:f.positions,stops:f.stops};
 }finally{f.close();}}
 assert.deepEqual(await trace(true),await trace(false));
});
test('pressure endpoint copies survive caller mutation and partial dwell restart',()=>{
 const m=dwellMove(motionLimits(100,100),[50,0,0,2],2),change={stepper:'e',advance:.08};markPressureBoundary(m,change);change.advance=.4;assert.equal(m.pressureBoundaries![0].advance,.08);markPressureBoundary(m,{stepper:'e',advance:.1});assert.equal(m.pressureBoundaries!.length,1);
 const stop=planPathStop([m],.5);assert.equal(stop.brake.length,0);assert.deepEqual(pressureBoundarySchedule(stop.remainder,3),[{stepper:'e',advance:.1,time:4.5}]);assert(Object.isFrozen(stop.remainder[0].pressureBoundaries![0]));
});
test('unknown pressure emitter stops source before generation and never publishes an accepted endpoint',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);const m=moves();markPressureBoundary(m[0],{stepper:'missing',advance:.1});assert.throws(()=>f.source.append(m),/emitter/);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.source.status.failed,true);assert.equal(f.source.status.sourceTime,1);assert.equal(f.commits,0);assert.equal(f.stops,1);}finally{f.close();}
});
test('invalid pressure metadata is rejected before source queues are changed',()=>{
 const f=idleMotionFixture(true);try{const m=moves();m[0].pressureBoundaries=[{stepper:'e',advance:NaN}];const before=f.equeue.extract(100,0,5);assert.throws(()=>f.source.validateBatch(m),/pressure/);assert.deepEqual(f.equeue.extract(100,0,5),before);assert.equal(f.stops,0);}finally{f.close();}
});
test('partial native pressure scheduling failure retires the source instead of permitting retry',async()=>{
 const f=idleMotionFixture(true);try{const q=new LookAheadQueue(),limits=motionLimits(100,100,5,0);q.add(new Move(limits,[50,0,0,2],[55,0,0,2.5],10));q.add(new Move(limits,[55,0,0,2.5],[60,0,0,3],10));const m=q.flush();for(const move of m)markPressureBoundary(move,{stepper:'e',advance:.1});let calls=0;const schedule=f.e.schedulePressureAdvance.bind(f.e),cause=new Error('second pressure update failed');f.e.schedulePressureAdvance=(time,advance)=>{if(++calls===2)throw cause;schedule(time,advance);};f.source.startAt(1);assert.throws(()=>f.source.append(m),e=>e===cause);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,2);assert.equal(f.stops,1);assert.equal(f.commits,0);assert.equal(f.coordinator.status.failed,true);assert.throws(()=>f.source.append([]),/failed/);}finally{f.close();}
});
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
