import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
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
