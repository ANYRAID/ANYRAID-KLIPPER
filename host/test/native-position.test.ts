import {test} from 'node:test';
import assert from 'node:assert/strict';
import {StepCompressor} from '../src/motion/step-compressor.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('initial MCU position seeds native history and subsequent compressed positions',()=>{using s=new StepCompressor(settings);const model=new StepperPosition(1,100);model.alignResponse(-123,true,0,p=>s.initializePosition(1000n,p));s.append(new Float64Array([1,.01,0,1,.02,0]));const result=s.flush();assert.equal(result.position,125n);assert.equal(model.mcuPosition(.02),125n);assert.ok(Array.from(result.history).includes(123n));assert.throws(()=>s.initializePosition(30000n,0n),/unused/);});
test('invalid, repeated and post-generation alignment is rejected without changing position',()=>{using s=new StepCompressor(settings);assert.throws(()=>s.initializePosition(-1n,0n));assert.throws(()=>s.initializePosition(1n,1n<<53n));s.initializePosition(1n,50n);assert.throws(()=>s.initializePosition(2n,0n),/unused/);assert.equal(s.flush().position,50n);using t=new StepCompressor(settings);t.append(new Float64Array([1,.1,0]));assert.throws(()=>t.initializePosition(1n,0n),/unused/);assert.equal(t.flush().position,1n);});
