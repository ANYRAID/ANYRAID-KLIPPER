import test from 'node:test';
import assert from 'node:assert/strict';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionOutput} from '../src/motion/coordinator.ts';
const out=(id:string,req=0n):MotionOutput=>({id,position:0n,history:new BigInt64Array(),messages:req?[{data:Buffer.from([1]),reqClock:req,minClock:1n}]:[]});
const transport={async send(){},async stop(){}};
test('targets use actual emitter ownership and retain precise largest clocks per MCU',async()=>{
 const base=1n<<54n,sink=new MoveQueueSink([{id:'main',emitters:['x','y'],moveSlots:2,clockAt:()=>base,transport},{id:'tool',emitters:['e'],moveSlots:2,clockAt:()=>base+10n,transport}],async()=>{});
 assert.throws(()=>sink.motionClockTargets({x:base,y:base,e:base}),/drained/);await sink.commit({sequence:0,from:0,until:1,outputs:[out('x'),out('y'),out('e')]});const result=sink.motionClockTargets({x:base+1n,y:base+2n,e:base+3n});assert.deepEqual(result,{main:base+2n,tool:base+10n});assert.ok(Object.isFrozen(result));assert.throws(()=>sink.motionClockTargets({x:base,e:base}),/every emitter/);assert.throws(()=>sink.motionClockTargets({x:base,y:base,unknown:base}),/every emitter/);await sink.stop(new Error('stop'));assert.throws(()=>sink.motionClockTargets({x:base,y:base,e:base}),/drained/);
});
test('future packets remaining in the scheduler prevent a completion boundary',async()=>{
 const sink=new MoveQueueSink([{id:'m',emitters:['x'],moveSlots:1,clockAt:t=>BigInt(t*100),transport}],async()=>{});await sink.commit({sequence:0,from:0,until:1,outputs:[out('x',200n)]});assert.throws(()=>sink.motionClockTargets({x:200n}),/drained/);await sink.commit({sequence:1,from:1,until:2,outputs:[out('x')]});assert.deepEqual(sink.motionClockTargets({x:200n}),{m:200n});
});
test('a commit in progress cannot expose a premature boundary',async()=>{
 let release!:()=>void;const sink=new MoveQueueSink([{id:'m',emitters:['x'],moveSlots:1,clockAt:()=>100n,transport}],()=>new Promise<void>(r=>{release=r;}));const committing=sink.commit({sequence:0,from:0,until:1,outputs:[out('x')]});assert.throws(()=>sink.motionClockTargets({x:100n}),/drained/);release();await committing;assert.deepEqual(sink.motionClockTargets({x:100n}),{m:100n});
});
test('native coordinator drain reaches MCU targets through the actual motion sink',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using step=q.createStepper({frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6},'x',.01);let packets=0;const sink=new MoveQueueSink([{id:'main',emitters:['x'],moveSlots:512,clockAt:t=>step.clockAt(t),transport:{async send(p){packets+=p.length;},async stop(){}}}],async()=>{}),c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],sink);const drained=await c.drain(2,new Map([[q,[9,0,0] as const]]));assert.ok(packets>0);assert.deepEqual(sink.motionClockTargets(drained.clocks),{main:step.clockAt(drained.generatedUntil)});
});
