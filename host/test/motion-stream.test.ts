import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
import {trajectory} from './helpers/motion-stream.ts';
test('streamed shaping and pressure advance preserve every native step compared with one final drain',async()=>{
 for(const kind of [0,1]){const streamed=await trajectory(kind,true),whole=await trajectory(kind,false);assert.equal(streamed.position,whole.position);assert.equal(streamed.ticks.length,whole.ticks.length);for(let i=0;i<whole.ticks.length;i++){assert.equal(streamed.ticks[i].position,whole.ticks[i].position);const delta=streamed.ticks[i].clock-whole.ticks[i].clock;assert.ok(delta>=-1n&&delta<=1n,`step ${i} differs by ${delta} ticks`);}}
});
test('source horizons reject invalid times and wait for enough future data without committing',async()=>{
 using q=new TrapQueue();using step=q.createStepper(settings,'x',.01);step.configureShapers({x:inputShaper('mzv',40,.1)});let commits=0;const c=new MotionCoordinator([{id:'x',queue:q,stepper:step}],{async commit(){commits++;},async stop(){}});
 assert.equal(await c.advanceSource(.001),false);assert.equal(commits,0);await assert.rejects(c.advanceSource(NaN),/horizon/);assert.equal(c.status.failed,false);
});
