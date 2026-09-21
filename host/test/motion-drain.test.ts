import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionBatch} from '../src/motion/coordinator.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const rows=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]);
test('coordinator drain generates shaped tail and returns final emitter clock after commit',async()=>{
 using q=new TrapQueue();q.appendRaw(rows);using step=q.createStepper(settings,'x',.01);step.configureShapers({x:inputShaper('mzv',40,.1)});const batches:Readonly<MotionBatch>[]=[];const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(b){batches.push(b);},async stop(){}});const result=await c.drain(2,new Map([[q,[9,0,0] as const]]));assert.equal(batches.length,1);assert.equal(batches[0].outputs[0].position,900n);assert.ok(batches[0].until>2+step.scanWindow.past);assert.equal(result.clocks.x,step.clockAt(batches[0].until));assert.equal(c.status.committedTime,batches[0].until);assert.ok(Object.isFrozen(result));
});
test('invalid endpoint coverage is rejected before mutating source queues',async()=>{
 using q=new TrapQueue();q.appendRaw(rows);using step=q.createStepper(settings,'x',.01);let commits=0;const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(){commits++;},async stop(){}});await assert.rejects(c.drain(2,new Map()),/endpoints/);assert.equal(c.status.failed,false);await c.drain(2,new Map([[q,[9,0,0] as const]]));assert.equal(commits,1);
});
test('drain failure fences the coordinator and stops the sink with its original cause',async()=>{
 using q=new TrapQueue();q.appendRaw(rows);using step=q.createStepper(settings,'x',.01);const cause=new Error('commit failed');let stops=0;const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(){throw cause;},async stop(error){assert.equal(error,cause);stops++;}});await assert.rejects(c.drain(2,new Map([[q,[9,0,0] as const]])),e=>e===cause);assert.equal(c.status.failed,true);assert.equal(stops,1);assert.equal(c.status.committedTime,0);
});
test('drain includes pressure-advance relaxation and reports source padding separately',async()=>{
 using q=new TrapQueue();const eligible=rows.slice();eligible[8]=1;q.appendRaw(eligible);using step=q.createStepper(settings,'extruder',.01);step.configurePressureAdvance(.05,.04);let position=0n;const c=new MotionCoordinator([{id:'e',queue:q,stepper:step}],{async commit(b){position=b.outputs[0].position;},async stop(){}});const result=await c.drain(2,new Map([[q,[9,0,0] as const]]));assert.equal(position,900n);assert.ok(result.generatedUntil>=2.02);assert.ok(result.sourceUntil>=result.generatedUntil+.02);assert.equal(result.clocks.e,step.clockAt(result.generatedUntil));
});
