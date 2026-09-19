import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import type {StepperKinematics} from '../src/motion/step-compressor.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const move=new Float64Array([1,.1,.8,.1,0,0,0,1,0,0,0,10,100]);
function run(mode:StepperKinematics,times:number[]) {
 using queue=new TrapQueue();queue.appendRaw(move);using stepper=queue.createStepper(settings,mode,.01);
 for(const time of times)stepper.generate(time);return stepper.flush();
}
test('Cartesian and CoreXY iterative steps are continuous across generation windows',()=>{
 for(const mode of ['x','y','z','corexy+','corexy-'] as const) {
  const whole=run(mode,[2]),chunked=run(mode,[1.025,1.1,1.35,1.9,2]);
  assert.deepEqual(chunked,whole);assert.equal(whole.position,mode==='y'||mode==='z'?0n:900n);
 }
});
test('queue cleanup waits for every attached solver and attached lifetime is protected',()=>{
 using queue=new TrapQueue();queue.appendRaw(move);
 using x=queue.createStepper(settings,'x',.01),y=queue.createStepper({...settings,oid:4},'y',.01);
 assert.throws(()=>queue.dispose(),/Detach/);assert.throws(()=>queue.setPosition(0,0,0,0),/Detach/);
 x.generate(2);assert.throws(()=>queue.finalize(2,1),/ungenerated/);
 y.generate(2);queue.finalize(2,1);assert.equal(x.flush().position,900n);
 queue.appendRaw(new Float64Array([2,0,.5,0,9,0,0,-1,0,0,10,10,0]));
 x.generate(2.5);y.generate(2.5);assert.equal(x.flush().position,400n);
});
test('solver rejects discontinuities, manual mixing, time rewinds and excessive step budgets',()=>{
 using queue=new TrapQueue();queue.appendRaw(move);using stepper=queue.createStepper(settings,'x',.01);
 assert.throws(()=>stepper.append(new Float64Array([1,.1,0])),/mix/);
 assert.throws(()=>stepper.generate(3),/within queued/);stepper.generate(1.5);assert.throws(()=>stepper.generate(1.4),/advance/);
 assert.throws(()=>queue.createStepper(settings,'x',1e-13));
 using tiny=queue.createStepper(settings,'x',.000001);assert.throws(()=>tiny.generate(2),/budget/);
 using wrong=queue.createStepper(settings,'x',.01,[10,0,0]);assert.throws(()=>wrong.generate(2),/Discontinuous/);
});
test('initial position and CoreXY motor directions are mapped before quantization',()=>{
 using queue=new TrapQueue();queue.appendRaw(new Float64Array([1,0,1,0,5,7,0,0,1,0,1,1,0]));
 using plus=queue.createStepper(settings,'corexy+',.01,[5,7,0]);using minus=queue.createStepper({...settings,oid:4},'corexy-',.01,[5,7,0]);
 assert(Math.abs(plus.generate(2)-13)<1e-10);assert(Math.abs(minus.generate(2)+3)<1e-10);
 assert.equal(plus.flush().position,100n);assert.equal(minus.flush().position,-100n);
});
test('native handle validation and repeated solver disposal keep queues usable',()=>{
 using queue=new TrapQueue();queue.appendRaw(move);
 using standalone=new StepCompressor(settings);assert.throws(()=>standalone.bindQueue({},'x',.01,[0,0,0]));
 for(let i=0;i<100;i++){using s=queue.createStepper(settings,'x',.01);s.generate(2);assert.equal(s.flush().position,900n);}
 queue.dispose();assert.throws(()=>queue.createStepper(settings,'x',.01));
});
test('lookahead-planned motion generates the expected physical step count',async()=>{
 const {Move,LookAheadQueue,motionLimits}=await import('../src/motion/lookahead.ts');
 const planner=new LookAheadQueue();planner.add(new Move(motionLimits(100,1000),[0,0,0,0],[100,0,0,0],100));
 using queue=new TrapQueue();const end=queue.appendPlanned(planner.flush(),1);using stepper=queue.createStepper(settings,'x',.01);
 assert(Math.abs(stepper.generate(end)-100)<1e-8);assert.equal(stepper.flush().position,10000n);
});
test('GC and environment shutdown keep attached native queues alive until solver cleanup',async()=>{
 const {spawnSync}=await import('node:child_process');
 const url=new URL('../src/motion/trap-queue.ts',import.meta.url).href;
 const source=`import {TrapQueue} from ${JSON.stringify(url)};
 const steppers=[];for(let i=0;i<20;i++){const q=new TrapQueue();q.appendRaw(new Float64Array(${JSON.stringify([...move])}));steppers.push(q.createStepper(${JSON.stringify(settings)},'x',.01));}
 global.gc();for(const s of steppers){s.generate(2);if(s.flush().position!==900n)throw new Error('lifetime failure');}console.log('done');`;
 const p=spawnSync(process.execPath,['--expose-gc','--input-type=module','-e',source],{encoding:'utf8',timeout:30000});assert.equal(p.status,0,p.stderr);assert.equal(p.stdout.trim(),'done');
});
test('coordinate and solver tolerance guards reject unrepresentable steps before native iteration',()=>{
 using queue=new TrapQueue();queue.appendRaw(move);
 assert.throws(()=>queue.createStepper(settings,'x',1e-9));
 assert.throws(()=>queue.createStepper(settings,'x',.01,[1e20,0,0]),/resolution/);
 using valid=queue.createStepper(settings,'x',.01);assert.equal(valid.flush().position,0n);
});
