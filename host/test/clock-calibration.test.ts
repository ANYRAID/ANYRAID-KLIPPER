import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
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
 const pending=c.advanceWindow(1.5,1.45);assert.throws(()=>c.calibrateClock(['x'],0,1000100),/idle/);release();await pending;s.dispose();assert.throws(()=>s.clockAt(2));
});
