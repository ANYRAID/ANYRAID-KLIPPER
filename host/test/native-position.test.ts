import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('initial MCU position seeds native history and subsequent compressed positions',()=>{using s=new StepCompressor(settings);const model=new StepperPosition(1,100);model.alignResponse(-123,true,0,p=>s.initializePosition(1000n,p));s.append(new Float64Array([1,.01,0,1,.02,0]));const result=s.flush();assert.equal(result.position,125n);assert.equal(model.mcuPosition(.02),125n);assert.ok(Array.from(result.history).includes(123n));assert.throws(()=>s.initializePosition(30000n,0n),/unused/);});
test('invalid, repeated and post-generation alignment is rejected without changing position',()=>{using s=new StepCompressor(settings);assert.throws(()=>s.initializePosition(-1n,0n));assert.throws(()=>s.initializePosition(1n,1n<<53n));s.initializePosition(1n,50n);assert.throws(()=>s.initializePosition(2n,0n),/unused/);assert.equal(s.flush().position,50n);using t=new StepCompressor(settings);t.append(new Float64Array([1,.1,0]));assert.throws(()=>t.initializePosition(1n,0n),/unused/);assert.equal(t.flush().position,1n);});
test('observed position forbids earlier or coincident manual steps without changing history',()=>{using s=new StepCompressor(settings);s.initializePosition(100000n,50n);assert.throws(()=>s.append(new Float64Array([1,.05,0])),/tick|clock|time/);assert.throws(()=>s.append(new Float64Array([1,.1,0])),/tick|clock|time/);s.append(new Float64Array([1,.100001,0]));assert.equal(s.flush().position,51n);});
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
test('observed position rejects generation of earlier actuator motion atomically',()=>{using q=new TrapQueue();q.appendRaw(new Float64Array([.5,0,.2,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);s.initializePosition(1000000n,50n);assert.throws(()=>s.generate(.7),/observed position/);assert.equal(s.generatedTime,0);assert.equal(s.flush().position,50n);});
test('shaper and pressure advance look-ahead cannot generate steps before observation',()=>{
 for(const mode of ['x','extruder'] as const){using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,1,0,0,10,100,2,0,.2,0,9,0,0,0,0,0,0,0,0]));using s=q.createStepper(settings,mode,.01);if(mode==='x')s.configureShapers({x:inputShaper('zvd',40,.1)});else s.configurePressureAdvance(.05,.04);s.initializePosition(995000n,0n);assert.throws(()=>s.generate(1.5),/observed position/);assert.equal(s.generatedTime,0);}
});
test('future motion and inactive axes remain usable after observation',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1.5,0,.2,0,0,0,0,1,0,0,1,1,0]));using s=q.createStepper(settings,'x',.01);s.initializePosition(1000000n,50n);s.generate(1.7);assert.equal(s.flush().position,70n);
 using other=new TrapQueue();other.appendRaw(new Float64Array([.5,0,.2,0,0,0,0,1,0,0,1,1,0]));using z=other.createStepper(settings,'z',.01);z.initializePosition(600000n,20n);z.generate(.7);assert.equal(z.flush().position,20n);
});
