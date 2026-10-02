import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
const geometry={kind:'delta' as const,armLength:100,towerX:0,towerY:0};
function run(times:number[]){using q=new TrapQueue();q.setPosition(0,-5,0,0);q.appendRaw(new Float64Array([1,0,1,0,-5,0,0,1,0,0,10,10,0]));using s=q.createStepper(settings,geometry,.001,[-5,0,0]);for(const t of times)s.generate(t);return s.flush();}
test('Delta tower reverses inside a straight Cartesian move and chunking preserves steps within one MCU tick',()=>{
 const whole=run([2]);assert.equal(whole.position,0n);assert(whole.messages.length>2);
 assert([...whole.history].filter((_,i)=>i%6===3).some(n=>n>0n));assert([...whole.history].filter((_,i)=>i%6===3).some(n=>n<0n));
 const chunked=run([1.25,1.5,1.75,2]);assert.equal(chunked.position,whole.position);
 const expand=(h:BigInt64Array)=>{const steps:bigint[][]=[];for(let i=h.length-6;i>=0;i-=6){let clock=h[i];const count=Number(h[i+3]<0n?-h[i+3]:h[i+3]);for(let j=0;j<count;j++){steps.push([clock,h[i+3]>0n?1n:-1n]);clock+=h[i+4]+BigInt(j+1)*h[i+5];}}return steps;};
 const a=expand(whole.history),b=expand(chunked.history);assert.equal(a.length,250);assert.equal(b.length,a.length);
 for(let i=0;i<a.length;i++){assert.equal(a[i][1],b[i][1]);const delta=a[i][0]-b[i][0];assert(delta>=-1n&&delta<=1n);}
 // Original CFFI reproduces this one-tick reversal difference; the oracle
 // benchmark compares whole and chunked inputs independently, byte for byte.
});
test('Delta vertical movement retains exact actuator displacement',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,0,0,1,10,10,0]));using s=q.createStepper(settings,geometry,.01);
 assert(Math.abs(s.generate(2)-110)<1e-8);assert.equal(s.flush().position,1000n);
});
test('Delta validates geometry, reach and singularity before generating',()=>{
 using q=new TrapQueue();
 for(const armLength of [0,-1,Infinity,1e200])assert.throws(()=>q.createStepper(settings,{...geometry,armLength},.01));
 assert.throws(()=>q.createStepper(settings,{...geometry,towerX:101},.01));
 q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,100,100,0]));using s=q.createStepper(settings,geometry,.01);
assert.throws(()=>s.generate(2),/Delta path/);
 s.generate(1.1);assert(s.flush().messages.length>0);
});
test('Delta accepts XYZ shaping with tail padding and retains its final vertical position',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,.1,.8,.1,0,0,0,0,0,1,0,10,100,2,0,.2,0,0,0,9,0,0,0,0,0,0]));
 using s=q.createStepper(settings,geometry,.01);s.configureShapers({z:{amplitudes:[1,1],times:[0,.02]}});
 assert.throws(()=>s.generate(2.2),/future motion/);s.generate(1.5);
 assert.throws(()=>q.finalize(1.5,0));q.finalize(s.scanWindow.safeFinalizeTime!,0);
 assert(Math.abs(s.generate(2.1)-109)<1e-8);assert.equal(s.flush().position,900n);
});
test('Delta shaping validates the whole convolved coordinate region before committing steps',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,1,0,9,9,0,2,0,.2,0,9,9,0,0,0,0,0,0,0]));
 using s=q.createStepper(settings,{...geometry,armLength:10},.01);s.configureShapers({x:{amplitudes:[1,1],times:[0,.02]},y:{amplitudes:[1,1],times:[0,.04]}});
 assert.throws(()=>s.generate(2.1),/Shaped Delta path/);assert.equal(s.flush().position,0n);
 s.generate(1.1);assert(s.flush().messages.length>0);
});
test('disabled Delta shapers preserve the unshaped native packets',()=>{
 function run(disabled:boolean){using q=new TrapQueue();q.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,10,10,0]));using s=q.createStepper(settings,geometry,.01);if(disabled)s.configureShapers({});s.generate(2);return s.flush();}
 assert.deepEqual(run(true),run(false));
});
test('Delta convolution bounds account for translated coordinates and small negative pulses',()=>{
 using q=new TrapQueue();q.setPosition(0,1000,0,0);q.appendRaw(new Float64Array([1,0,1,0,1000,0,0,0,1,0,1,1,0,2,0,.2,0,1000,1,0,0,0,0,0,0,0]));
 using s=q.createStepper(settings,{...geometry,towerX:1000},.001,[1000,0,0]);s.configureShapers({x:{amplitudes:[-1e-6,1],times:[0,.02]},y:{amplitudes:[1,1],times:[0,.02]}});
 s.generate(2.1);assert.equal(s.flush().position,-5n);
});
