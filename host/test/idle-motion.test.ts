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

test('source window barrier preserves exact XYZE pulses through subsequent motion',async()=>{
 async function trace(sourceBarrier:boolean,advance:number,smoothTime:number){const f=idleMotionFixture(true);try{
  f.source.startAt(1);f.source.append(idleTestMove(50,51,2));const end=f.source.status.sourceTime;
  const changes=[{stepper:'e',advance,smoothTime}],next=idleTestMove(51,52,2.1);
  if(sourceBarrier){await f.source.reconfigurePressureWindows(changes,signal());assert.equal(f.source.status.paused,false);assert.equal(f.source.status.braking,false);assert(f.source.status.sourceTime>end);assert.equal(f.coordinator.status.generatedTime,f.coordinator.status.committedTime);assert.throws(()=>f.source.resumeAt(10),/resume/);await f.source.drain(next,signal());}
  else{const boundary=await f.coordinator.drain(end,new Map([[f.xyz,[51,0,0] as const],[f.equeue,[2,0,0] as const]]),.25,undefined,Math.max(.001,advance?smoothTime*.5:0));f.coordinator.reconfigurePressureWindows(boundary.generatedUntil,changes);const t=f.xyz.appendPlanned(next,boundary.sourceUntil);assert.equal(f.equeue.appendPlanned(next,boundary.sourceUntil,3),t);await f.coordinator.drain(t,new Map([[f.xyz,[52,0,0] as const],[f.equeue,[2.1,0,0] as const]]),.25);}
  assert.deepEqual(f.positions,{x:300n,e:30n});return {ticks:f.ticks,positions:f.positions,filters:f.e.recoveryFilters()};
 }finally{f.close();}}
 for(const [advance,smooth] of [[.1,.2],[.1,.01],[0,.04],[.1,0]])assert.deepEqual(await trace(true,advance,smooth),await trace(false,advance,smooth));
});
test('source window barrier validates before seeding and requires a resting active tail',async()=>{
 const f=idleMotionFixture(true);try{
  f.source.startAt(1);const before=f.source.status;
  for(const changes of [[],[{stepper:'e',advance:.1,smoothTime:1e-200}],[{stepper:'e',advance:.1,smoothTime:.04},{stepper:'e',advance:.2,smoothTime:.04}]])await assert.rejects(f.source.reconfigurePressureWindows(changes,signal()));
  assert.deepEqual(f.source.status,before);assert.equal(f.commits,0);assert.equal(f.stops,0);
  const moves=idleTestMove();moves[0]!.profile!.endV=1;f.source.append(moves);const end=f.source.status.sourceTime;await assert.rejects(f.source.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal()),/ending at rest/);assert.equal(f.source.status.sourceTime,end);assert.equal(f.commits,0);
 }finally{f.close();}
});
test('window barrier snapshots requests and fences admission until output delivery completes',async()=>{
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let settled=0,stopped=0;
 const delivered:{id:number;time:number}[][]=[];
 const f=idleMotionFixture(true,undefined,{async deliver(boundaries){delivered.push(boundaries.map(b=>({...b})));entered();await gate;},invalidateAfter(){},async settle(){settled++;},async stop(){stopped++;}});
 try{f.source.startAt(1);f.source.append(idleTestMove(50,51,2));f.source.markBoundary(17);const end=f.source.status.sourceTime,changes=[{stepper:'e',advance:.1,smoothTime:.2}];const pending=f.source.reconfigurePressureWindows(changes,signal());changes[0]!.smoothTime=.3;await started;
  assert.equal(f.source.status.busy,true);assert.equal(f.source.status.sourceTime,end);assert.throws(()=>f.source.append([]),/busy/);await assert.rejects(f.source.reconfigurePressureWindows(changes,signal()),/busy/);release();await pending;
  assert.deepEqual(delivered,[[{id:17,time:end}]]);assert.equal(settled,0);assert.equal(stopped,0);assert.equal(f.e.scanWindow.future,.1);assert.equal(f.source.status.paused,false);assert(f.source.status.sourceTime>end);
 }finally{release();f.close();}
});
test('window output failure is terminal without publishing a new source time',async()=>{
 const cause=new Error('window output failed');let stopped=0;
 const f=idleMotionFixture(true,undefined,{async deliver(){throw cause;},invalidateAfter(){},async settle(){assert.fail('must not settle');},async stop(){stopped++;}});
 try{f.source.startAt(1);f.source.append(idleTestMove(50,51,2));const time=f.source.status.sourceTime;
  await assert.rejects(f.source.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal()),e=>e===cause);assert.equal(f.source.status.sourceTime,time);assert.equal(f.source.status.failed,true);assert.equal(f.stops,1);assert.equal(stopped,1);assert.throws(()=>f.source.append([]),/failed/);
 }finally{f.close();}
});
test('stationary window switches can enable pressure before first motion and require fresh time after drain',async()=>{
 const f=idleMotionFixture(true);try{f.e.configurePressureAdvance(0,.04);f.source.startAt(1);await f.source.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal());assert.equal(f.ticks.e.length+f.ticks.x.length,0);assert.equal(f.source.status.paused,false);
  await f.source.drain(idleTestMove(),signal());const before=f.source.status;await assert.rejects(f.source.reconfigurePressureWindows([{stepper:'e',advance:0,smoothTime:.04}],signal()),/active source/);assert.deepEqual(f.source.status,before);
  f.source.resumeAt(10);await f.source.reconfigurePressureWindows([{stepper:'e',advance:0,smoothTime:.04}],signal());assert.equal(f.e.scanWindow.future,0);assert.equal(f.source.status.paused,false);assert.deepEqual(f.positions,{x:200n,e:30n});
 }finally{f.close();}
});
test('motion after a window boundary cannot inherit a nonzero junction velocity',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);await f.source.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal());const moves=idleTestMove();moves[0]!.profile!.startV=1;assert.throws(()=>f.source.validateBatch(moves),/start at rest/);assert.equal(f.source.status.failed,false);assert.equal(f.stops,0);}finally{f.close();}
});
test('window padding preserves the exact source endpoint across subtraction rounding',async()=>{
 const f=idleMotionFixture(true);try{
  const from=.02416;f.source.startAt(from);await f.source.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal());const until=f.source.status.sourceTime;
  assert.notEqual(from+(until-from),until);
  await f.source.drain(idleTestMove(),signal());assert.deepEqual(f.positions,{x:200n,e:30n});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('paused pressure barriers replace deferred intent and reuse one stationary generation',async()=>{
 const f=idleMotionFixture(true);try{
  await assert.rejects(f.source.reconfigurePausedPressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal()),/paused source/);assert.equal(f.stops,0);
  f.source.startAt(1);await f.source.drain(idleTestMove(),signal());f.source.markIdlePressureBoundary({stepper:'e',advance:.12});
  await f.source.reconfigurePausedPressureWindows([{stepper:'e',advance:.2,smoothTime:.2}],signal());assert.equal(f.source.status.pendingBoundaries,0);const time=f.source.status.sourceTime,generated=f.coordinator.status.generatedTime;
  for(const smoothTime of [0,.02,.2,.04])await f.source.reconfigurePausedPressureWindows([{stepper:'e',advance:.3,smoothTime}],signal());
  assert.equal(f.source.status.paused,true);assert.equal(f.source.status.sourceTime,time);assert.equal(f.coordinator.status.generatedTime,generated);f.source.resumeAt(3);await f.source.drain([],signal());assert.deepEqual(f.e.recoveryFilters(),{pressureAdvance:{advance:.3,smoothTime:.04}});assert.equal(f.stops,0);
 }finally{f.close();}
});
test('an asynchronous paused window observer fails terminally after native acceptance',async()=>{
 const f=idleMotionFixture(true);try{f.source.startAt(1);await f.source.drain(idleTestMove(),signal());await assert.rejects(f.source.reconfigurePausedPressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal(),30000,async()=>{}),/must be synchronous/);assert.equal(f.source.status.failed,true);assert.equal(f.stops,1);}finally{f.close();}
});
