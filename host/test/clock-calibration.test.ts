import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('source flush commits an already generated calibration boundary without duplicating packets',async()=>{
 for(const bounded of [false,true]){
  using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,2,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);let commits=0;
  const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){commits++;},async stop(){}});await c.advanceWindow(1,.95);
  const sourceUntil=1.006,generated=sourceUntil-.001;c.generateCalibrationBoundary(generated);assert.equal(commits,1);
  assert.equal(await c.advanceSource(sourceUntil,0,bounded?.25:undefined),true);assert.equal(c.status.generatedTime,generated);assert.equal(c.status.committedTime,generated-.002);assert.equal(commits,2);
  assert.equal(await c.advanceSource(sourceUntil,0,bounded?.25:undefined),false);assert.equal(commits,2);await c.shutdown();
 }
});
test('calibration boundary generation is synchronous, bounded and never flushes packets',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,2,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);let commits=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){commits++;},async stop(){}});await c.advanceWindow(1,.95);const before=c.status,count=commits;
 assert.equal(c.generateCalibrationBoundary(1.001),undefined);assert.equal(c.status.generatedTime,1.001);assert.equal(c.status.committedTime,before.committedTime);assert.equal(s.generatedTime,1.001);assert.equal(commits,count);
 for(const until of [NaN,Infinity,1,1.1])assert.throws(()=>c.generateCalibrationBoundary(until));assert.equal(c.status.generatedTime,1.001);
 await c.advance(2);assert.equal(s.flush().position,200n);await c.shutdown();assert.throws(()=>c.generateCalibrationBoundary(2.001),/healthy/);
});
test('a pulse at the exact calibration anchor is rejected atomically and the next tick preserves it',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([4e-7,0,2,0,0,0,0,1,0,0,20,20,0]));
 using x=q.createStepper(settings,'x',.0125),z=q.createStepper({...settings,oid:4},'z',.0125);let commits=0,stops=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'z',queue:q,stepper:z}],{async commit(){commits++;},async stop(){stops++;}}),clock=new PrintClockTimeline({offset:0,frequency:1e6});
 try{
  c.generateCalibrationBoundary(.000312);const first=clock.planCalibration(c.status.generatedTime,.002,1000100);assert(first);assert.equal(first.tick,313n);c.generateCalibrationBoundary(first.time);
  const before=clock.status,calibration=x.calibration;
  assert.throws(()=>clock.calibrateMotion(first.tick,1000100,c,['z','x']),error=>{
   assert(error instanceof RangeError);assert.equal(error.message,'Calibration would overlap previously accepted step clocks');
   assert.equal((error as RangeError&{code:string}).code,'ERR_CLOCK_CALIBRATION_ANCHOR_PULSE');
   assert.deepEqual((error as RangeError&{calibrationBoundary:unknown}).calibrationBoundary,{candidateClock:'313',latestClock:'313',flushedClock:'0',stepAccounting:'8',generatedTime:first.time,candidateRawClock:313,applying:false});return true;
  });
  const nextMapping={offset:first.time-Number(first.tick)/1000100,frequency:1000100};
  assert.throws(()=>x.calibrateClock(nextMapping.offset,nextMapping.frequency),{code:'ERR_CLOCK_CALIBRATION_OVERLAP'});
  assert.throws(()=>x.validateClockCalibration(nextMapping.offset+1e-6,nextMapping.frequency),{code:'ERR_CLOCK_CALIBRATION_OVERLAP'});
  assert.deepEqual(clock.status,before);assert.deepEqual(x.calibration,calibration);assert.deepEqual(z.calibration,calibration);assert.equal(c.status.failed,false);assert.equal(commits,0);assert.equal(stops,0);
  const next=clock.planCalibration(c.status.generatedTime,.002,1000100);assert(next);assert.equal(next.tick,314n);c.generateCalibrationBoundary(next.time);clock.calibrateMotion(next.tick,1000100,c,['z','x']);
  assert.deepEqual(x.calibration,clock.status.calibration);assert.deepEqual(z.calibration,x.calibration);assert.equal(commits,0);assert.equal(stops,0);
  const accepted=x.flush();assert.equal(accepted.position,1n);assert.equal(accepted.history.length,6);assert.equal(accepted.history[0],313n);assert.equal(accepted.history[1],313n);assert.equal(accepted.history[3],1n);
 }finally{await c.shutdown();}
});
test('motion history cutoff uses retained calibration instead of the latest affine mapping',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,101,0,0,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,'x',.01);
 const clock=new PrintClockTimeline({offset:0,frequency:1e6}),c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){}},1024,0,[],new Map([['x',clock]]));
 await c.advanceWindow(100,99.95);clock.calibrateMotion(100000000n,1000100,c,['x']);
 assert.notEqual(s.printTimeAtClock(90000000n),90);assert.equal(c.historyCutoff({x:90000000n}),59.999);clock.retireBefore(100000000n);assert.equal(clock.status.fromClock,0n);
 const tick=clock.clockAt(140);assert.equal(c.historyCutoff({x:tick}),109.999);clock.retireBefore(tick);assert.equal(clock.status.fromClock,100000000n);
 await c.shutdown();
});
test('motion clock history remains pinned until asynchronous retirement settles',async()=>{
 using q=new TrapQueue();using s=q.createStepper(settings,'x',.01);const held=Promise.withResolvers<void>(),clock=new PrintClockTimeline({offset:0,frequency:1e6});
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){},retire:()=>held.promise},1024,0,[],new Map([['x',clock]]));
 clock.append(1000000n,1000100);const retired=c.retire(new AbortController().signal);clock.retireBefore(2000000n);assert.equal(clock.status.fromClock,0n);
 held.resolve();await retired;clock.retireBefore(2000000n);assert.equal(clock.status.fromClock,1000000n);
});
test('partial history lease acquisition is rolled back if a later timeline is full',async()=>{
 using q=new TrapQueue();using x=q.createStepper(settings,'x',.01),y=q.createStepper({...settings,oid:4},'y',.01);
 const a=new PrintClockTimeline({offset:0,frequency:1e6}),b=new PrintClockTimeline({offset:0,frequency:1e6}),leases=Array.from({length:1024},()=>b.retain());
 assert.throws(()=>new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'y',queue:q,stepper:y}],{async commit(){},async stop(){}},1024,0,[],new Map([['x',a],['y',b]])),/reader limit/);
 a.append(1000000n,1e6);a.retireBefore(1000000n);assert.equal(a.status.fromClock,1000000n);for(const lease of leases)lease.release();
});
test('shared clock calibration publishes motion and peripheral mappings at the generated boundary',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using x=q.createStepper(settings,'x',.01),z=q.createStepper({...settings,oid:4},'z',.01);
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'z',queue:q,stepper:z}],{async commit(){},async stop(){}}),clock=new PrintClockTimeline({offset:0,frequency:1e6});
 await c.advanceWindow(1.5,1.45);clock.reserve(1.4);clock.calibrateMotion(1500000n,1000100,c,['x','z']);
 assert.equal(clock.clockAt(1.4),1400000n);assert.equal(x.clockAt(1.5),1500000n);assert.deepEqual(x.calibration,clock.status.calibration);assert.deepEqual(z.calibration,x.calibration);
 for(const t of [1.5,1.6,2])assert.equal(x.clockAt(t),clock.clockAt(t));await c.advanceWindow(2,1.95);await c.advance(2);assert.equal(c.status.failed,false);
});
test('reserved output and unsolved intervals reject shared calibration without changing any owner',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,2,0,0,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,'x',.01);const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){}}),clock=new PrintClockTimeline({offset:0,frequency:1e6});
 await c.advanceWindow(1,.95);const before=clock.status;
 assert.throws(()=>clock.calibrateMotion(1100000n,1000100,c,['x']),/boundary/);assert.deepEqual(clock.status,before);assert.equal(s.calibration.frequency,1e6);
 clock.reserve(1);assert.throws(()=>clock.calibrateMotion(1000000n,1000100,c,['x']),/reserved/);assert.equal(clock.status.segments,1);assert.equal(s.calibration.frequency,1e6);
});
test('shared calibration blocks reentrant output reservation from a health guard',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,2,0,0,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,'x',.01);const clock=new PrintClockTimeline({offset:0,frequency:1e6});let armed=false;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){},async stop(){}},1024,0,[{assertActive(){if(armed)clock.reserve(2);}}]);
 await c.advanceWindow(1,.95);armed=true;assert.throws(()=>clock.calibrateMotion(1000000n,1000100,c,['x']),/transaction/);
 assert.equal(s.calibration.frequency,1e6);assert.equal(clock.status.segments,1);assert.equal(c.status.failed,true);await c.shutdown();
});
test('calibration retains clocks of pending steps and changes only subsequent conversion',()=>{
 using s=new StepCompressor(settings);s.append(new Float64Array([1,1,0]));s.calibrateClock(-.01,1e6);assert.equal(s.clockAt(1),1010000n);
 s.append(new Float64Array([1,1.1,0]));const r=s.flush();assert.equal(r.position,2n);
 const h=r.history;assert.equal(h[h.length-6],1000000n);assert.equal(h[1],1110000n);
});
test('invalid or overlapping clock estimates leave the old mapping usable',()=>{
 using s=new StepCompressor(settings);s.append(new Float64Array([1,1,0]));
 for(const [offset,freq] of [[NaN,1e6],[0,1e-320],[0,0],[0,1e10],[1,1e6],[0,999999]])assert.throws(()=>s.calibrateClock(offset,freq));
 assert.equal(s.clockAt(1),1000000n);s.calibrateClock(0,1e6);s.append(new Float64Array([1,1.1,0]));assert.equal(s.flush().position,2n);
 assert.throws(()=>s.clockAt(Infinity));assert.throws(()=>s.clockAt(-1));
});
test('a calibration group validates all steppers before updating any mapping',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using x=q.createStepper(settings,'x',.01),z=q.createStepper({...settings,oid:4},'z',.01);
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'z',queue:q,stepper:z}],{async commit(){},async stop(){assert.fail('unexpected stop');}});
 await c.advanceWindow(1.5,1.45);assert.throws(()=>c.calibrateClock(['z','x'],.001,1e6),/overlap/);assert.equal(z.clockAt(2),2000000n);
 c.calibrateClock(['x','z'],0,1000100);assert.equal(x.clockAt(2),2000200n);assert.equal(z.clockAt(2),2000200n);
 await c.advanceWindow(2,1.95);await c.advance(2);assert.equal(c.status.failed,false);
});
test('calibration cannot race a pending commit and closed steppers reject clock conversion',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);let release!:()=>void;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{commit:()=>new Promise<void>(r=>{release=r;}),async stop(){}});
 const pending=c.advanceWindow(1.5,1.45);assert.throws(()=>c.calibrateClock(['x'],0,1000100),/idle/);assert.throws(()=>c.generateCalibrationBoundary(1.501),/idle/);release();await pending;s.dispose();assert.throws(()=>s.clockAt(2));
});
