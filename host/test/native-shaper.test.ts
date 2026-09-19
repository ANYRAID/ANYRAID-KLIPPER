import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import type {StepperKinematics} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const rows=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100,2,0,.1,0,9,0,0,0,0,0,0,0,0]);
function run(mode:StepperKinematics,parts:number[],enabled=true){
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,mode,.01);
 if(enabled)s.configureShapers({x:inputShaper('mzv',40,.1)});
 for(const t of parts)s.generate(t);return s.flush();
}
test('native shaper changes pulse times while retaining endpoint and chunk consistency',()=>{
 const shaped=run('x',[2.05]);
 assert.equal(shaped.position,900n);
 assert.deepEqual(shaped,run('x',[1.05,1.5,1.95,2.05]));
 assert.notDeepEqual(shaped.messages,run('x',[2.05],false).messages);
 for(const mode of ['corexy+','corexy-'] as const)assert.equal(run(mode,[2.05]).position,900n);
});
test('shaper scan windows guard future motion and retain the backward convolution window',()=>{
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);
 s.configureShapers({x:inputShaper('zvd',40,.1)});const w=s.scanWindow;assert(w.future>0&&w.past>0);assert.equal(w.safeFinalizeTime,null);assert.throws(()=>q.finalize(0,0),/ungenerated/);
 assert.throws(()=>s.generate(2.1),/future motion/);s.generate(1.5);
 assert.throws(()=>q.finalize(1.5,0),/ungenerated/);
 q.finalize(s.scanWindow.safeFinalizeTime!,0);s.generate(2.05);assert.equal(s.flush().position,900n);
 assert.throws(()=>s.configureShapers({}),/before step generation/);
});
test('invalid shaper replacement leaves prior configuration usable',()=>{
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);
 s.configureShapers({x:inputShaper('zv',40)});const before=s.scanWindow;
 assert.throws(()=>s.configureShapers({x:{amplitudes:[1,1],times:[0,121]}}));assert.deepEqual(s.scanWindow,before);
 s.configureShapers({});assert.equal(s.scanWindow.future,0);s.generate(2);assert.equal(s.flush().position,900n);
});
test('initial padding cannot skip real motion',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,.1,0,0,0,0,1,0,0,10,10,0,.1,0,10,0,1,0,0,0,0,0,0,0,0]));
 using s=q.createStepper(settings,'x',.01);s.configureShapers({x:inputShaper('zv',.1)});
 assert.throws(()=>s.generate(6),/padding contains motion/);
});
test('discontinuous source motion is rejected before entering convolution',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,.1,0,0,0,0,1,0,0,1,1,0,1.1,0,.1,0,1,0,0,1,0,0,1,1,0,1.1+.1,0,.1,0,1.1,0,0,0,0,0,0,0,0]));
 using s=q.createStepper(settings,'x',.01);s.configureShapers({x:inputShaper('mzv',40)});
 assert.throws(()=>s.generate(1.25),/Discontinuous shaper source/);assert.equal(s.flush().position,0n);
});
test('shaped generation can continue after flushing and adding future motion',()=>{
 using q=new TrapQueue();q.appendRaw(rows);using s=q.createStepper(settings,'x',.01);s.configureShapers({x:inputShaper('mzv',40)});
 s.generate(1.5);const first=s.flush();assert(first.position>0n&&first.position<900n);q.finalize(s.scanWindow.safeFinalizeTime!,0);
 q.appendRaw(new Float64Array([2.1,0,.5,0,9,0,0,-1,0,0,10,10,0,2.6,0,.1,0,4,0,0,0,0,0,0,0,0]));
 s.generate(2.65);assert.equal(s.flush().position,400n);
});
test('disabled shaping needs no artificial past window at motion time zero',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,.1,0,0,0,0,1,0,0,10,10,0]));
 using s=q.createStepper(settings,'x',.01);s.configureShapers({});q.finalize(0,0);
 s.generate(.1);assert.equal(s.flush().position,100n);
});
