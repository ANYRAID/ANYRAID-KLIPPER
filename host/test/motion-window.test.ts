import test from 'node:test';
import assert from 'node:assert/strict';
import {trajectory} from './helpers/motion-stream.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('bounded generation preserves shaped and pressure-advance step clocks and positions',async()=>{
 for(const kind of [0,1]){const a=await trajectory(kind,false,true,.1),b=await trajectory(kind,false);assert.equal(a.position,b.position);assert.equal(a.ticks.length,b.ticks.length);for(let i=0;i<a.ticks.length;i++){assert.equal(a.ticks[i].position,b.ticks[i].position);const d=a.ticks[i].clock-b.ticks[i].clock;assert.ok(d>=-1n&&d<=1n);}}
});
test('bounded operation owns every window and stops on a later partially accepted prefix',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,.1,1.8,.1,0,0,0,1,0,0,0,10,100]));using step=q.createStepper(settings,'x',.01);let commits=0,stops=0,release!:()=>void;const cause=new Error('third commit failed');
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(b){assert.equal(b.sequence,commits);commits++;if(commits===1)await new Promise<void>(r=>{release=r;});if(commits===3)throw cause;},async stop(error){assert.equal(error,cause);stops++;}});
 const pending=c.advanceBounded(1.9),failed=assert.rejects(pending,e=>e===cause);assert.equal(c.status.busy,true);await assert.rejects(c.advance(1));await assert.rejects(c.advanceBounded(1));assert.throws(()=>c.calibrateClock(['x'],0,1e6));release();await failed;
 assert.equal(commits,3);assert.equal(stops,1);assert.equal(c.status.failed,true);assert.equal(c.status.busy,false);assert.equal(c.status.committedTime,.498);await assert.rejects(c.advanceBounded(1.9));assert.equal(commits,3);
});
test('invalid bounded requests do not generate or consume a usable coordinator',async()=>{
 using q=new TrapQueue();using step=q.createStepper(settings,'x',.01);const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(){assert.fail('unexpected commit');},async stop(){assert.fail('unexpected stop');}});
 for(const args of [[1,0,1,0],[1,0,1,2],[NaN,0,1,.25],[1,2,1,.25],[1e10,0,1e10,.25]])await assert.rejects(c.advanceBounded(...args as [number,number,number,number]),RangeError);assert.equal(c.status.failed,false);assert.equal(c.status.generatedTime,0);await c.advanceBounded(0);
});
test('long in-memory sequences yield so an event-loop stop can fence remaining windows',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,.1,2.8,.1,0,0,0,1,0,0,0,10,100]));using step=q.createStepper(settings,'x',.01);let commits=0,stops=0;const cause=new Error('scheduled emergency');let c:MotionCoordinator;
 c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(){if(++commits===1)setImmediate(()=>{void c.shutdown(cause);});},async stop(){stops++;}});await assert.rejects(c.advanceBounded(2.9),e=>e===cause);assert.equal(commits,8);assert.equal(stops,1);assert.equal(c.status.failed,true);
});
import {inputShaper} from '../src/motion/shaper.ts';
test('startup convolution padding may exceed the ordinary generation window without dropping motion',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,1,0,0,0,0,0,0,0,0,0,0,1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using step=q.createStepper(settings,'x',.01);step.configureShapers({x:inputShaper('zvd',1,.1)});assert.ok(step.scanWindow.past>.25);const horizons:number[]=[];let position=0n;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(b){horizons.push(b.generatedUntil!);position=b.outputs[0].position;},async stop(){}});await c.drain(2,new Map([[q,[9,0,0] as const]]),.25);assert.equal(position,900n);assert.ok(horizons[0]>.25);for(let i=1;i<horizons.length;i++)assert.ok(horizons[i]-horizons[i-1]<=.250000000001);
});
