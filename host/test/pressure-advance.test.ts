import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
function extrusion(eligible=1){return new Float64Array([1,.1,.8,.1,0,0,0,1,eligible,0,0,10,100,2,0,.2,0,9,0,0,0,0,0,0,0,0]);}
function run(pa:number,times=[2.1],eligible=1){using q=new TrapQueue();q.appendRaw(extrusion(eligible));using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(pa,.04);for(const time of times)s.generate(time);return s.flush();}
test('pressure advance adds acceleration compensation and settles to the nominal endpoint',()=>{
 const shaped=run(.05);assert.equal(shaped.position,900n);assert.notDeepEqual(shaped.messages,run(0).messages);
 assert.deepEqual(shaped,run(.05,[1.05,1.5,1.95,2.1]));
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);
 assert(Math.abs(s.generate(1.5)-5)<1e-9);assert.equal(s.flush().position,500n);
});
test('pressure advance eligibility is encoded by the E queue rather than raw Y distance',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion(0));using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);
 assert(Math.abs(s.generate(1.5)-4.5)<1e-9);assert.equal(s.flush().position,450n);
});
test('extrude-only and retract moves pass through planned E motion with pressure advance enabled',()=>{
 const planner=new LookAheadQueue(),limits=motionLimits(50,1000);
 planner.add(new Move(limits,[0,0,0,0],[0,0,0,2],10));planner.add(new Move(limits,[0,0,0,2],[0,0,0,-1],10));
 using q=new TrapQueue();const end=q.appendPlanned(planner.flush(),1,3);
 q.appendRaw(new Float64Array([end,0,.2,0,-1,0,0,0,0,0,0,0,0]));
 using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.generate(end+.1);assert.equal(s.flush().position,-100n);
});
test('pressure configuration is atomic and keeps its scan history until generated',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);
 assert.deepEqual(s.scanWindow,{future:.02,past:.02,safeFinalizeTime:null});
 for(const [advance,smooth] of [[-1,.04],[NaN,.04],[.05,.201],[.05,1e-200]])assert.throws(()=>s.configurePressureAdvance(advance,smooth));
 assert.equal(s.scanWindow.future,.02);assert.throws(()=>s.configureShapers({}));
 s.generate(1.5);assert.throws(()=>q.finalize(1.5,0));q.finalize(s.scanWindow.safeFinalizeTime!,0);
 assert.throws(()=>s.configurePressureAdvance(.1,.04),/before generation/);s.generate(2.1);assert.equal(s.flush().position,900n);
});
test('pressure advance validates dedicated queues and cleans repeated pre-print replacements',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);
 for(let i=0;i<100;i++)s.configurePressureAdvance(i%2?.05:0,.04);s.generate(2.1);assert.equal(s.flush().position,900n);
 using x=q.createStepper(settings,'x',.01);assert.throws(()=>x.configurePressureAdvance(.05));
 using bad=new TrapQueue();bad.appendRaw(new Float64Array([1,0,1,0,0,0,0,.5,0,0,1,1,0]));using e=bad.createStepper(settings,'extruder',.01);assert.throws(()=>e.generate(2),/dedicated E/);
});
test('zero smoothing disables advance and unsafe generation can be retried after reconfiguration',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);
 s.configurePressureAdvance(100,.04);assert.throws(()=>s.generate(2.1),/budget|clock resolution/);
 s.configurePressureAdvance(.05,0);assert.deepEqual(s.scanWindow,{future:0,past:0,safeFinalizeTime:0});
 s.generate(2.1);assert.deepEqual(s.flush(),run(0));
});
test('scheduled pressure changes cannot rewrite generated convolution and preserve long source phases',()=>{
 function run(live:boolean){using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.2,.1);if(!live)s.schedulePressureAdvance(1.8,.2);s.generate(1.6);if(live)s.schedulePressureAdvance(1.8,.2);s.generate(2.1);return s.flush();}
 assert.deepEqual(run(true),run(false));assert.equal(run(true).position,900n);
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.generate(1.5);
 for(const [time,advance] of [[1.52,.1],[1.6,0],[1.6,-1],[NaN,.1],[1.6,Infinity]])assert.throws(()=>s.schedulePressureAdvance(time,advance));
 s.schedulePressureAdvance(1.8,.1);assert.throws(()=>s.schedulePressureAdvance(1.7,.2));s.generate(2.1);assert.equal(s.flush().position,900n);
});
test('pressure update queue is bounded and releases history once source phases retire',()=>{
 using q=new TrapQueue();const rows:number[]=[];let time=1,x=0;
 for(let i=0;i<200;i++){rows.push(time,0,.1,0,x,0,0,1,1,0,1,1,0);time+=.1;x+=.1;}
 rows.push(time,0,.2,0,x,0,0,0,0,0,0,0,0);q.appendRaw(new Float64Array(rows));using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.01,.04);
 for(let i=1;i<128;i++)s.schedulePressureAdvance(i*.1,i%2?.02:.01);
 assert.throws(()=>s.schedulePressureAdvance(12.8,.03),/Too many pending/);
 s.generate(14);s.flush();s.schedulePressureAdvance(15,.03);s.generate(time+.1);assert.equal(s.flush().position,2000n);
});
test('scheduled pressure changes require a configured fixed nonzero window',()=>{
 using q=new TrapQueue();using e=q.createStepper(settings,'extruder',.01);assert.throws(()=>e.schedulePressureAdvance(1,.1));
 e.configurePressureAdvance(.1,0);assert.throws(()=>e.schedulePressureAdvance(1,.1));using x=q.createStepper(settings,'x',.01);assert.throws(()=>x.schedulePressureAdvance(1,.1));
});
test('an empty queue does not retire future pressure changes through the tail sentinel',()=>{
 using q=new TrapQueue();using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.01,.04);
 for(let i=1;i<128;i++)s.schedulePressureAdvance(i*.1,i%2?.02:.01);
 assert.throws(()=>s.schedulePressureAdvance(12.8,.03),/Too many pending/);
});
test('cancelling ungenerated pressure updates preserves queued pulses and matches never-scheduled reference',()=>{
 function trace(cancelled:boolean){using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.05,.1);if(cancelled)s.schedulePressureAdvance(1.8,.2);s.generate(1.4);const prefix=s.flush();if(cancelled){assert.throws(()=>s.recoveryFilters(),/settle/);s.cancelPressureAdvanceAfter(1.5);assert.deepEqual(s.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});}s.schedulePressureAdvance(1.7,.15);s.generate(2.1);return {prefix,tail:s.flush(),filters:s.recoveryFilters()};}
 assert.deepEqual(trace(true),trace(false));
});
test('pressure cancellation rejects generated convolution and preserves state after errors',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.8,.2);s.generate(1.4);
 const before=s.commandedPosition,window=s.scanWindow;for(const time of [1.4,1.42,NaN,Infinity,-1,1e15])assert.throws(()=>s.cancelPressureAdvanceAfter(time));assert.equal(s.commandedPosition,before);assert.deepEqual(s.scanWindow,window);assert.throws(()=>s.recoveryFilters(),/settle/);
 s.cancelPressureAdvanceAfter(1.5);assert.deepEqual(s.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});s.generate(2.1);assert.equal(s.flush().position,900n);
});
test('pressure cancellation retains exact cutoff updates, releases capacity and remains bounded across retries',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.5,.1);s.schedulePressureAdvance(1.8,.2);s.cancelPressureAdvanceAfter(1.5);assert.throws(()=>s.recoveryFilters(),/settle/);assert.throws(()=>s.schedulePressureAdvance(1.5,.3));
 for(let i=0;i<300;i++){s.schedulePressureAdvance(1.8,.2);s.cancelPressureAdvanceAfter(1.5);}s.generate(2.1);assert.deepEqual(s.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});assert.equal(s.flush().position,900n);
 using empty=new TrapQueue();using e=empty.createStepper({...settings,oid:4},'extruder',.01);e.configurePressureAdvance(.01,.04);for(let i=1;i<128;i++)e.schedulePressureAdvance(i*.1,i%2?.02:.01);assert.throws(()=>e.schedulePressureAdvance(12.8,.03),/Too many/);e.cancelPressureAdvanceAfter(.5);e.schedulePressureAdvance(1,.03);
});
test('pressure cancellation preserves coefficients of a retained long source phase after history pruning',()=>{
 function trace(cancelled:boolean){using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,10,0,0,0,0,1,1,0,1,1,0,11,0,.2,0,10,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.01,.04);s.schedulePressureAdvance(.5,.02);s.schedulePressureAdvance(2,.03);s.generate(5);const prefix=s.flush();s.schedulePressureAdvance(7,.04);if(cancelled){s.schedulePressureAdvance(9,.1);s.cancelPressureAdvanceAfter(8);}s.generate(11.1);return {prefix,tail:s.flush()};}assert.deepEqual(trace(true),trace(false));
});
test('pressure cancellation cannot be applied to unconfigured, disabled, wrong-mode or closed solvers',()=>{
 using q=new TrapQueue();using s=q.createStepper(settings,'extruder',.01);assert.throws(()=>s.cancelPressureAdvanceAfter(1));s.configurePressureAdvance(.1,0);assert.throws(()=>s.cancelPressureAdvanceAfter(1));using x=q.createStepper(settings,'x',.01);assert.throws(()=>x.cancelPressureAdvanceAfter(1));s.dispose();assert.throws(()=>s.cancelPressureAdvanceAfter(1),/closed/);
});
test('tail revisions preserve generated pulses and equal a single final scheduled coefficient',()=>{
 function trace(revise:boolean){using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.5,revise?.2:.1);s.generate(1.4);const prefix=s.flush();if(revise){for(let i=0;i<300;i++)s.setPressureAdvanceAtTail(1.5,i%2?.3:.05);s.setPressureAdvanceAtTail(1.5,.1);}s.generate(2.1);return {prefix,tail:s.flush(),filters:s.recoveryFilters()};}
 assert.deepEqual(trace(true),trace(false));
});
test('tail revision rejects old times and generated convolution without changing accepted filters',()=>{
 using q=new TrapQueue();q.appendRaw(extrusion());using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.05,.04);s.schedulePressureAdvance(1.8,.1);s.generate(1.4);const position=s.commandedPosition;
 for(const [time,advance] of [[1.7,.2],[1.42,.2],[1.8,0],[1.8,NaN],[Infinity,.2]])assert.throws(()=>s.setPressureAdvanceAtTail(time,advance));assert.equal(s.commandedPosition,position);assert.throws(()=>s.recoveryFilters(),/settle/);s.setPressureAdvanceAtTail(1.8,.05);assert.deepEqual(s.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});s.schedulePressureAdvance(1.9,.08);
});
test('tail replacement reuses full history capacity and coalesces no-op records',()=>{
 using q=new TrapQueue();using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.01,.04);for(let i=1;i<128;i++)s.schedulePressureAdvance(i*.1,i%2?.02:.01);assert.throws(()=>s.setPressureAdvanceAtTail(12.8,.03),/Too many/);s.setPressureAdvanceAtTail(127*.1,.03);s.setPressureAdvanceAtTail(127*.1,.01);s.setPressureAdvanceAtTail(12.8,.04);assert.throws(()=>s.setPressureAdvanceAtTail(12.7,.1),/tail/);
});
test('tail revisions prune consumed short phases while preserving native generation continuity',()=>{
 using q=new TrapQueue();const rows:number[]=[],ends:number[]=[];let time=1;for(let i=0;i<200;i++){rows.push(time,0,.1,0,i*.1,0,0,1,1,0,1,1,0);time+=.1;ends.push(time);}rows.push(time,0,.2,0,20,0,0,0,0,0,0,0,0);q.appendRaw(new Float64Array(rows));using s=q.createStepper(settings,'extruder',.01);s.configurePressureAdvance(.01,.04);
 for(const [i,t] of ends.entries()){s.setPressureAdvanceAtTail(t,i%2?.02:.01);s.generate(t-.04);s.flush();}s.generate(time+.1);s.flush();assert.deepEqual(s.recoveryFilters(),{pressureAdvance:{advance:.02,smoothTime:.04}});
});
test('tail updates reject unconfigured, disabled, wrong-mode and closed emitters',()=>{
 using q=new TrapQueue();using e=q.createStepper(settings,'extruder',.01);assert.throws(()=>e.setPressureAdvanceAtTail(1,.1),/enabled/);e.configurePressureAdvance(.1,0);assert.throws(()=>e.setPressureAdvanceAtTail(1,.2),/enabled/);using x=q.createStepper({...settings,oid:4},'x',.01);assert.throws(()=>x.setPressureAdvanceAtTail(1,.1),/enabled/);e.dispose();assert.throws(()=>e.setPressureAdvanceAtTail(1,.1),/closed/);
});
