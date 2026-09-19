import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionBatch} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:25,queueStepTag:5,directionTag:6};
function fill(q:TrapQueue){q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,.5,0,0,10,100,2,0,.2,0,9,4.5,0,0,0,0,0,0,0]));}
test('coordinator generates shared XYZ and shaped E before commit and cleans only after acceptance',async()=>{
 using q=new TrapQueue();fill(q);using x=q.createStepper(settings,'x',.01),y=q.createStepper({...settings,oid:4},'y',.01);
 using eq=new TrapQueue();eq.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,1,0,0,10,100,2,0,.2,0,9,0,0,0,0,0,0,0,0]));using e=eq.createStepper({...settings,oid:5},'extruder',.01);e.configurePressureAdvance(.05,.04);
 y.configureShapers({y:{amplitudes:[1,1],times:[0,.04]}});const batches:MotionBatch[]=[];
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'y',queue:q,stepper:y},{id:'e',queue:eq,stepper:e}],{async commit(b){assert.equal(x.generatedTime,b.until);assert.equal(y.generatedTime,b.until);assert.equal(e.generatedTime,b.until);assert.throws(()=>q.setPosition(0,0,0,0));batches.push(b);},async stop(){assert.fail('unexpected stop');}});
 await c.advance(1.5);await c.advance(2.1,1);assert.equal(batches.length,2);assert.equal(batches[1].outputs[0].position,900n);assert.equal(batches[1].outputs[1].position,450n);
 assert.equal(batches[1].outputs[2].position,900n);assert.equal(c.status.committedTime,2.1);await c.advance(2.1);assert.equal(batches.length,2);
});
test('coordinator rejects foreign, duplicate and differently advanced bindings',()=>{
 using q=new TrapQueue();fill(q);using a=q.createStepper(settings,'x',.01),b=q.createStepper(settings,'y',.01);using foreign=new TrapQueue();const sink={async commit(){},async stop(){}};
 assert.throws(()=>new MotionCoordinator([{id:'a',queue:foreign,stepper:a}],sink));
 assert.throws(()=>new MotionCoordinator([{id:'a',queue:q,stepper:a},{id:'b',queue:q,stepper:a}],sink));
 a.generate(1.5);assert.throws(()=>new MotionCoordinator([{id:'a',queue:q,stepper:a},{id:'b',queue:q,stepper:b}],sink));
 b.generate(1.5);assert.throws(()=>new MotionCoordinator([{id:'a',queue:q,stepper:a},{id:'b',queue:q,stepper:b}],sink));
});
test('partial generation failure sends no batch, stops once and forbids retry',async()=>{
 using q=new TrapQueue();fill(q);using a=q.createStepper(settings,'x',.01),b=q.createStepper(settings,'y',.01,[0,100,0]);let commits=0,stops=0;
 const c=new MotionCoordinator([{id:'a',queue:q,stepper:a},{id:'b',queue:q,stepper:b}],{async commit(){commits++;},async stop(){stops++;}});
 await assert.rejects(c.advance(2.1),/Discontinuous/);assert.equal(commits,0);assert.equal(stops,1);assert.equal(c.status.committedTime,0);
 await assert.rejects(c.advance(2.1),/faulted/);await c.shutdown();assert.equal(stops,1);
});
test('commit backpressure prevents overlapping batches; shutdown fences an in-flight commit',async()=>{
 using q=new TrapQueue();fill(q);using s=q.createStepper(settings,'x',.01);let release!:()=>void,stops=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{commit:()=>new Promise<void>(r=>{release=r;}),async stop(){stops++;}});
 const pending=c.advance(2.1);await assert.rejects(c.advance(2.1),/in progress/);await c.shutdown();release();await assert.rejects(pending,/shutdown/);
 assert.equal(stops,1);assert.equal(c.status.committedTime,0);assert.equal(c.status.failed,true);
});
test('partial commit and stop errors remain visible without replaying packets',async()=>{
 using q=new TrapQueue();fill(q);using s=q.createStepper(settings,'x',.01);let commits=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){commits++;throw new Error('partial write');},async stop(){throw new Error('stop failed');}});
 await assert.rejects(c.advance(2.1),AggregateError);assert.equal(commits,1);assert.equal(c.status.failed,true);await assert.rejects(c.advance(2.1),/faulted/);
});
test('invalid times leave the coordinator usable while oversized native output faults it',async()=>{
 using q=new TrapQueue();fill(q);using s=q.createStepper(settings,'x',.01);let commits=0,stops=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){commits++;},async stop(){stops++;}},1);
 await assert.rejects(c.advance(NaN));assert.equal(c.status.failed,false);await assert.rejects(c.advance(2.1),/budget/);assert.equal(stops,1);assert.equal(commits,0);
});
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
test('native coordinated motion reaches the MCU slot scheduler with retained step history',async()=>{
 using q=new TrapQueue();fill(q);using x=q.createStepper(settings,'x',.01),y=q.createStepper({...settings,oid:4},'y',.01);let histories=0,packets=0;const ids=new Set<string>();
 const sink=new MoveQueueSink([{id:'main',emitters:['x','y'],moveSlots:8,clockAt:t=>BigInt(Math.round(t*1e6)),transport:{async send(messages){assert(histories>0);packets+=messages.length;for(const p of messages)ids.add(p.id);},async stop(){assert.fail('unexpected stop');}}}],async outputs=>{histories+=outputs.reduce((sum,o)=>sum+o.history.length,0);});
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:x},{id:'y',queue:q,stepper:y}],sink);await c.advanceWindow(1.5,1.45);await c.advanceWindow(2.1,2.05);await c.advance(2.1);assert(packets>0);assert.deepEqual(ids,new Set(['x','y']));assert.equal(c.status.committedTime,2.1);
});
