import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {rebuildStoppedMotion,type StoppedEmitter} from '../src/homing/rebuild-motion.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
function oldMotion(){const queue=new TrapQueue(),stepper=queue.createStepper(settings,'x',.01);queue.appendRaw(new Float64Array([1,0,1,0,0,0,0,1,0,0,100,100,0]));stepper.generate(2);return {id:'x',queue,stepper};}
const observation={hitClock:1200000n,reasons:[1],positions:[{member:0,oid:3,raw:2500,position:2500n,observedClock:1500000n}]};
const emitter:StoppedEmitter={id:'x',queueId:'xyz',member:0,settings,mode:'x',rotationDistance:1,stepsPerRotation:100};
test('stopped replacement retires unexecuted motion and starts at readback without replay',()=>{
 const old=oldMotion();using rebuilt=rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[emitter],1.6);
 assert.throws(()=>old.stepper.flush(),/closed/);assert.throws(()=>old.queue.appendRaw(new Float64Array()),/closed/i);
 const b=rebuilt.bindings[0];assert.equal(b.stepper.generatedTime,1.6);assert.equal(b.stepper.commandedPosition,25);assert.equal(b.position.mcuPosition(25),2500n);
 const initial=b.stepper.flush();assert.equal(initial.messages.length,0);assert.equal(initial.position,2500n);b.history.append(initial,1600000n);
 b.queue.appendRaw(new Float64Array([1.6,0,.1,0,25,0,0,1,0,0,1,1,0]));b.stepper.generate(1.7);
 const moved=b.stepper.flush();assert.equal(moved.position,2510n);b.history.append(moved,1700000n);assert.equal(b.history.at(1700000n),2510n);
 assert.equal(b.position.mcuPosition(b.stepper.commandedPosition),2510n);for(let i=0;i<moved.history.length;i+=6)assert(moved.history[i]>=1600000n);
});
test('invalid replacement does not retire the old group, including late native validation',()=>{
 for(const invalid of [{...emitter,settings:{...settings,frequency:0}},{...emitter,rotationDistance:0},{...emitter,settings:{...settings,invertDirection:true}}]){
  const old=oldMotion();assert.throws(()=>rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[invalid],1.6));assert.equal(old.stepper.flush().position,10000n);old.stepper.dispose();old.queue.dispose();
 }
 const old=oldMotion();assert.throws(()=>rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[emitter],1.4),/precedes/);assert.equal(old.stepper.generatedTime,2);old.stepper.dispose();old.queue.dispose();
});
test('CoreXZ coupled native coordinates and inverted signed32 boundary are reconciled',()=>{
 const q=new TrapQueue(),a=q.createStepper(settings,'corexz+',.01),c=q.createStepper({...settings,oid:4},'corexz-',.01);
 const result={hitClock:null,reasons:[2],positions:[{member:0,oid:3,raw:123,position:123n,observedClock:1000000n},{member:0,oid:4,raw:-2147483648,position:2147483648n,observedClock:1000001n}]};
 using next=rebuildStoppedMotion(result,[{id:'x',queue:q,stepper:a},{id:'z',queue:q,stepper:c}],[{id:'xyz',position:[20,0,5]}],[{...emitter,mode:'corexz+'},{...emitter,id:'z',mode:'corexz-',settings:{...settings,oid:4,invertDirection:true}}],1.1);
 assert.deepEqual(next.bindings.map(b=>b.stepper.commandedPosition),[25,15]);
 assert.deepEqual(next.bindings.map(b=>b.position.mcuPosition(b.stepper.commandedPosition)),[123n,2147483648n]);
 assert.deepEqual(next.bindings.map(b=>b.stepper.flush().position),[123n,2147483648n]);
});
test('fresh shaper and pressure advance preserve stationary baseline before new motion',()=>{
 for(const mode of ['x','extruder'] as const){
  const old=oldMotion(),filter=mode==='x'?{shapers:{x:inputShaper('zvd',40,.1)}}:{pressureAdvance:{advance:.05,smoothTime:.04}};
  using next=rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[{...emitter,mode,...filter}],1.6);const b=next.bindings[0];
  b.queue.appendRaw(new Float64Array([1.6,0,.4,0,25,0,0,0,0,0,0,0,0]));b.stepper.generate(1.9);assert.equal(b.stepper.flush().position,2500n);assert.equal(b.stepper.commandedPosition,25);
  assert(b.stepper.scanWindow.future>0&&b.stepper.scanWindow.past>0);
  b.queue.appendRaw(new Float64Array([2,0,.1,0,25,0,0,1,1,0,1,1,0,2.1,0,.4,0,25.1,0,0,0,0,0,0,0,0]));
  b.stepper.generate(2.4);assert.equal(b.stepper.flush().position,2510n);
 }
});
test('MCU-specific calibration maps independent observations to one fresh generation boundary',()=>{
 const q=new TrapQueue(),a=q.createStepper(settings,'x',.01),b=q.createStepper(settings,'y',.01);
 const old=[{id:'x',queue:q,stepper:a},{id:'y',queue:q,stepper:b}];
 const observed={hitClock:1200000n,reasons:[1,2],positions:[observation.positions[0],{member:1,oid:3,raw:400,position:400n,observedClock:5000000n}]};
 using next=rebuildStoppedMotion(observed,old,[{id:'xyz',position:[25,4,0]}],[emitter,{...emitter,id:'y',member:1,mode:'y',settings:{...settings,frequency:2e6,timeOffset:-1}}],1.6);
 assert.deepEqual(next.bindings.map(b=>b.stepper.generatedTime),[1.6,1.6]);
 assert.deepEqual(next.bindings.map(b=>b.stepper.clockAt(1.6)),[1600000n,5200000n]);
 assert.deepEqual(next.bindings.map(b=>b.position.mcuPosition(b.stepper.commandedPosition)),[2500n,400n]);
});
test('incomplete groups and extra attached solvers never publish a replacement',()=>{
 const old=oldMotion();assert.throws(()=>rebuildStoppedMotion({...observation,positions:[]},[old],[{id:'xyz',position:[25,0,0]}],[emitter],1.6),/group/);
 assert.throws(()=>rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[{...emitter,id:'other'}],1.6),/emitter/);
 const extra=old.queue.createStepper({...settings,oid:4},'y',.01);
 assert.throws(()=>rebuildStoppedMotion(observation,[old],[{id:'xyz',position:[25,0,0]}],[emitter],1.6),/Detach/);
 assert.throws(()=>old.stepper.generate(2),/closed/);extra.dispose();old.queue.dispose();
});
