import test from 'node:test';
import assert from 'node:assert/strict';
import {idleMotionFixture,idleTestMove} from './helpers/idle-motion.ts';
import {stationaryRows} from '../src/motion/stationary.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const signal=()=>new AbortController().signal;
test('idle pressure requests coalesce and bind to the final startup time without creating pulses',async()=>{
 async function trace(queued:boolean){const f=idleMotionFixture(true);try{
  if(queued){const change={stepper:'e',advance:.08};f.source.markIdlePressureBoundary(change);change.advance=.3;f.source.markIdlePressureBoundary({stepper:'e',advance:.1});assert.equal(f.source.status.pendingBoundaries,1);assert.throws(()=>f.source.retireProducer(),/pending pressure/);assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});}
  f.source.startAt(1);f.source.startAt(2);if(!queued)f.e.schedulePressureAdvance(2,.1);await f.source.prepareIdle(signal());assert.equal(f.source.status.pendingBoundaries,0);assert.equal(f.ticks.e.length+f.ticks.x.length,0);assert.throws(()=>f.e.recoveryFilters(),/settle/);
  await f.source.drain(idleTestMove(),signal());assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});return {ticks:f.ticks,positions:f.positions,stops:f.stops};
 }finally{f.close();}}
 assert.deepEqual(await trace(true),await trace(false));
});
test('idle pressure applies before the first appended motion even without separate idle preparation',async()=>{
 async function trace(queued:boolean){const f=idleMotionFixture(true);try{f.source.startAt(1);if(queued)f.source.markIdlePressureBoundary({stepper:'e',advance:.08});else f.e.schedulePressureAdvance(1,.08);await f.source.drain(idleTestMove(),signal());assert.equal(f.source.status.pendingBoundaries,0);return {ticks:f.ticks,positions:f.positions,filters:f.e.recoveryFilters()};}finally{f.close();}}
 assert.deepEqual(await trace(true),await trace(false));
});
test('drained idle pressure waits for an explicit fresh timestamp and preserves physical counters',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);await f.source.prepareIdle(signal());await f.source.drain([],signal());for(let i=1;i<=4;i++){f.source.markIdlePressureBoundary({stepper:'e',advance:.05+i*.01});assert.throws(()=>f.source.validateBatch([]),/fresh print time/);f.source.resumeAt(1+i*3600);await f.source.prepareIdle(signal());await f.source.drain([],signal());assert.equal(f.source.status.pendingBoundaries,0);assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.05+i*.01,smoothTime:.04}});assert.deepEqual(f.positions,{x:100n,e:20n});}assert.equal(f.ticks.e.length+f.ticks.x.length,0);assert.equal(f.stops,0);}finally{f.close();}
});
test('active source and invalid coefficients cannot accept an idle pressure request',async()=>{
 const f=idleMotionFixture(true);try{for(const advance of [0,-1,NaN,Infinity])assert.throws(()=>f.source.markIdlePressureBoundary({stepper:'e',advance}),/pressure/);assert.equal(f.source.status.pendingBoundaries,0);f.source.startAt(1);await f.source.prepareIdle(signal());assert.throws(()=>f.source.markIdlePressureBoundary({stepper:'e',advance:.1}),/unused or drained/);f.source.append(idleTestMove());assert.throws(()=>f.source.markIdlePressureBoundary({stepper:'e',advance:.1}),/unused or drained/);assert.equal(f.stops,0);}finally{f.close();}
});
test('invalid idle emitter or insufficient lead stops without moving the boundary or sending steps',async()=>{
 for(const invalidEmitter of [false,true]){const f=idleMotionFixture(true);try{const time=invalidEmitter?1:0;f.source.startAt(time);f.source.markIdlePressureBoundary({stepper:invalidEmitter?'missing':'e',advance:.1});await assert.rejects(f.source.prepareIdle(signal()),/endpoint or emitter/);assert.equal(f.source.status.sourceTime,time);assert.equal(f.source.status.pendingBoundaries,0);assert.equal(f.source.status.failed,true);assert.equal(f.commits,0);assert.equal(f.stops,1);}finally{f.close();}}
});
test('idle pressure storage stays bounded and repeated requests reuse their emitter slot',()=>{
 const f=idleMotionFixture(true);try{for(let i=0;i<64;i++)f.source.markIdlePressureBoundary({stepper:`e${i}`,advance:.08});assert.equal(f.source.status.pendingBoundaries,64);for(let i=0;i<1000;i++)f.source.markIdlePressureBoundary({stepper:'e0',advance:.1});assert.equal(f.source.status.pendingBoundaries,64);assert.throws(()=>f.source.markIdlePressureBoundary({stepper:'overflow',advance:.1}),/batch/);assert.equal(f.source.status.pendingBoundaries,64);assert.equal(f.commits,0);assert.equal(f.stops,0);}finally{f.close();}
});
test('repeated idle source preparation drains across a subtraction-rounding boundary',async()=>{
 const f=idleMotionFixture();try{
  const from=.0242,until=4.23456789;f.source.startAt((from-.001)-.001);await f.source.prepareIdle(signal());await f.source.drain([],signal());assert.equal(f.source.status.sourceTime,from);assert(from+(until-from)>until);
  f.source.resumeAt(until);await f.source.prepareIdle(signal(),30000,.01);await f.source.drain([],signal());assert.equal(f.source.status.paused,true);assert.equal(f.ticks.x.length+f.ticks.e.length,0);assert.deepEqual(f.positions,{x:100n,e:20n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('stationary source splits rounded intervals without shifting their endpoint or creating pulses',()=>{
 const from=.0242,until=4.23456789;assert(from+(until-from)>until);
 using q=new TrapQueue();q.setPosition(from,50,0,0);using s=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01,[50,0,0]);s.initializePosition(0n,100n);
 const rows=stationaryRows(from,until,[50,0,0]);assert.equal(rows.length,26);assert.equal(rows[0]+rows[2],rows[13]);assert.equal(rows[13]+rows[15],until);
 q.appendRaw(rows);q.appendRaw(stationaryRows(until,until+.1,[50,0,0]));s.generate(until+.05);const result=s.flush();assert.equal(result.position,100n);assert.equal(result.history.length,0);
 for(let i=1;i<1000;i++){const start=i/10000,end=4.23456789,r=stationaryRows(start,end,[0,0,0]);assert.equal(r[0],start);for(let j=0;j<r.length-13;j+=13)assert.equal(r[j]+r[j+2],r[j+13]);assert.equal(r.at(-13)!+r.at(-11)!,end);}
});
for(const gap of [3600,86400,604800])for(const filtered of [false,true])test(`idle source advances once without steps (seconds=${gap}, filtered=${filtered})`,async()=>{
 const f=idleMotionFixture(filtered);try{
  f.source.startAt(gap);assert.equal(await f.source.prepareIdle(signal()),true);assert.equal(f.commits,1);assert.deepEqual(f.positions,{x:100n,e:20n});assert.equal(f.ticks.x.length+f.ticks.e.length,0);
  f.source.append(idleTestMove());const before=f.coordinator.status;assert.equal(await f.source.prepareIdle(signal()),false);assert.deepEqual(f.coordinator.status,before);
  await f.source.drain([],signal());assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('idle preparation after full drain retains counters across another hour and resumes',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);await f.source.prepareIdle(signal());await f.source.drain(idleTestMove(50,51,2),signal());const steps=f.ticks.x.length+f.ticks.e.length,commits=f.commits;
  f.source.resumeAt(3601);await f.source.prepareIdle(signal());assert.equal(f.commits,commits+1);assert.equal(f.ticks.x.length+f.ticks.e.length,steps);assert.deepEqual(f.positions,{x:200n,e:20n});
  await f.source.drain(idleTestMove(51,52,2),signal());assert.deepEqual(f.positions,{x:300n,e:20n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('misdeclared XYZ or E movement fails before any idle batch can be committed',async()=>{
 for(const extrusion of [false,true]){const f=idleMotionFixture();try{
  f.source.startAt(.1);f.source.append(extrusion?idleTestMove(50,50,3):idleTestMove(50,51,2));
  await assert.rejects(f.coordinator.advanceIdleSource(f.source.status.sourceTime),/Idle advance contains step motion/);assert.equal(f.commits,0);assert.equal(f.stops,1);assert.equal(f.coordinator.status.failed,true);
 }finally{f.close();}}
});
