import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {MotionCoordinator,type MotionBatch} from '../src/motion/coordinator.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('partial flush retains a future reversible step across a direction change',()=>{
 using c=new StepCompressor(settings);c.append(new Float64Array([1,1,0]));assert.equal(c.flushThrough(.999).messages.length,0);
 c.append(new Float64Array([0,1.0001,0]));const r=c.flush();assert.equal(r.messages.length,0);assert.equal(r.position,0n);
});
test('partial flush releases completed history once while retaining later steps and rejects rewinds',()=>{
 using c=new StepCompressor(settings);c.append(new Float64Array([1,1,0,1,1.1,0,1,1.2,0]));
 const first=c.flushThrough(1.05);assert(first.messages.length>0);assert(first.history.length>0);
 const again=c.flushThrough(1.05);assert.equal(again.messages.length,0);assert.equal(again.history.length,0);
 assert.throws(()=>c.flushThrough(1.04),/rewind/);assert.throws(()=>c.flushThrough(NaN));assert.equal(c.flushThrough(1.2).position,3n);
});
test('partial flushing cannot erase the native pending-step resource count',()=>{
 using c=new StepCompressor(settings);const rows=new Float64Array(180000*3);
 for(let i=0;i<180000;i++){rows[i*3]=1;rows[i*3+1]=1+i*.001;}
 c.append(rows);const first=c.flushThrough(0);
 // Core auto-compresses older steps to limit its internal ring; a future tail
 // still remains and must count against subsequent append allocations.
 const more=new Float64Array(180000*3);for(let i=0;i<180000;i++){more[i*3]=1;more[i*3+1]=200+i*.001;}
 assert.throws(()=>c.append(more),/capacity/);
 const last=c.flush();assert.equal(last.position,180000n);let count=0n;
 for(const result of [first,last])for(let i=0;i<result.history.length;i+=6){const h=result.history,n=h[i+3];count+=n;assert.equal(h[i+1],h[i]+h[i+4]*(n-1n)+h[i+5]*n*(n-1n)/2n);}
 assert.equal(count,180000n);
});
test('coordinator separates generated and committed boundaries and drains without generating twice',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]));using s=q.createStepper(settings,'x',.01);const batches:MotionBatch[]=[];
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(b){batches.push(b);},async stop(){assert.fail('unexpected stop');}});
 await assert.rejects(c.advanceWindow(1,1),/1 ms/);assert.equal(c.status.failed,false);
 await c.advanceWindow(1.5,1.45);assert.equal(c.status.generatedTime,1.5);assert.equal(c.status.committedTime,1.45);assert.equal(batches[0].generatedUntil,1.5);
 await c.advanceWindow(2,1.95);await c.advance(2);assert.equal(batches[2].from,1.95);assert.equal(batches[2].until,2);assert.equal(batches[2].outputs[0].position,900n);
});
test('generation-only progress retains pending output until a later commit',async()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);let commits=0;
 const c=new MotionCoordinator([{id:'x',queue:q,stepper:s}],{async commit(){commits++;},async stop(){assert.fail('unexpected stop');}});
 await c.advanceWindow(1.5,0);assert.equal(commits,0);assert.equal(c.status.generatedTime,1.5);await c.advance(1.5);assert.equal(commits,1);
 assert.throws(()=>s.flushThrough(2),/ungenerated/);
});
