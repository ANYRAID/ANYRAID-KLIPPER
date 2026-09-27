import test from 'node:test';
import assert from 'node:assert/strict';
import {StepHistory} from '../src/motion/step-history.ts';
import {StepperPosition} from '../src/motion/stepper-position.ts';
import {observedStepperPosition} from '../src/motion/observed-position.ts';
test('observed position uses exact pulse ticks and logical direction, not the final queued position',()=>{
 const start=1n<<54n,h=new StepHistory(start,100n),p=new StepperPosition(40,3200);p.align(100n,5);
 h.append({history:new BigInt64Array([start+10n,start+40n,100n,4n,10n,0n]),position:104n},start+50n);
 assert.equal(observedStepperPosition(h,p,start),5);assert.equal(observedStepperPosition(h,p,start+19n),p.commandedPosition(101n));assert.equal(observedStepperPosition(h,p,start+20n),p.commandedPosition(102n));
 h.append({history:new BigInt64Array([start+60n,start+90n,104n,-4n,10n,0n]),position:100n},start+100n);
 assert.equal(observedStepperPosition(h,p,start+60n),p.commandedPosition(103n));assert.equal(observedStepperPosition(h,p,start+90n),5);
});
test('retired or ungenerated clocks remain unknown, including replaced coordinate baselines',()=>{
 const old=new StepHistory(100n,10n),p=new StepperPosition(40,3200);old.append({history:new BigInt64Array(),position:10n},200n);
 assert.equal(observedStepperPosition(old,p,99n),undefined);assert.equal(observedStepperPosition(old,p,201n),p.commandedPosition(10n));old.pruneBefore(150n);assert.equal(observedStepperPosition(old,p,149n),undefined);
 const next=new StepHistory(200n,10n),rebase=new StepperPosition(40,3200);rebase.align(10n,0);assert.equal(observedStepperPosition(next,rebase,199n),undefined);assert.equal(observedStepperPosition(next,rebase,200n),0);assert.throws(()=>observedStepperPosition(next,rebase,-1n));
});
test('tail sampling never includes a queued pulse still in the future',()=>{
 const h=new StepHistory(100n,0n),p=new StepperPosition(40,3200);h.append({history:new BigInt64Array([110n,150n,0n,5n,10n,0n]),position:5n},120n);
 assert.equal(observedStepperPosition(h,p,119n),p.commandedPosition(1n));assert.equal(observedStepperPosition(h,p,130n),undefined);assert.equal(observedStepperPosition(h,p,150n),p.commandedPosition(5n));
});
test('encoder observation includes native pressure advance pulses and converges at rest',async()=>{
 const {TrapQueue}=await import('../src/motion/trap-queue.ts');
 const sample=(advance:number)=>{using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,1,1,0,0,10,100,2,0,.2,0,9,0,0,0,0,0,0,0,0]));using step=q.createStepper({frequency:1e6,timeOffset:0,oid:1,maxError:0,queueStepTag:8,directionTag:9},'extruder',.01);step.configurePressureAdvance(advance,.04);step.generate(2.1);const h=new StepHistory(0n,0n);h.append(step.flush(),2100000n);const p=new StepperPosition(1,100);return [observedStepperPosition(h,p,1500000n)!,observedStepperPosition(h,p,3000000n)!];};
 const normal=sample(0),advanced=sample(.05);assert(Math.abs(advanced[0]-normal[0]-.5)<=.01);assert.equal(normal[1],9);assert.equal(advanced[1],9);
});
