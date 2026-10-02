import test from 'node:test';
import assert from 'node:assert/strict';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {recoveryEmitters} from '../src/homing/recovery-emitters.ts';
import {nativeFilterTrace} from './helpers/native-filter-trace.ts';
const settings={frequency:1e6,timeOffset:0,oid:3,maxError:0,queueStepTag:5,directionTag:6};
test('recovery filters own accepted settings and failed configuration leaves them unchanged',()=>{
 using q=new TrapQueue();using x=q.createStepper(settings,'x',.01);const shaper=inputShaper('mzv',40,.1);x.configureShapers({x:shaper});const expected=x.recoveryFilters();shaper.amplitudes.fill(0);const copy=x.recoveryFilters();copy.shapers!.x!.times.fill(0);assert.deepEqual(x.recoveryFilters(),expected);
 assert.throws(()=>x.configureShapers({x:{amplitudes:[0],times:[0]}}));assert.deepEqual(x.recoveryFilters(),expected);x.configureShapers({});assert.deepEqual(x.recoveryFilters().shapers,{x:{amplitudes:[],times:[]},y:{amplitudes:[],times:[]},z:{amplitudes:[],times:[]}});
 using e=q.createStepper({...settings,oid:4},'extruder',.01);e.configurePressureAdvance(.05,.04);assert.throws(()=>e.configurePressureAdvance(-1,.04));assert.deepEqual(e.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});e.dispose();assert.throws(()=>e.recoveryFilters(),/closed/);
});
test('pressure transition cannot be promoted early, and settled recovery takes the accepted latest coefficient',()=>{
 using q=new TrapQueue();q.appendRaw(new Float64Array([0,0,3,0,0,0,0,0,0,0,0,0,0]));using e=q.createStepper(settings,'extruder',.01);e.configurePressureAdvance(.05,.04);e.schedulePressureAdvance(1,.1);
 assert.throws(()=>e.recoveryFilters(),/must settle/);e.generate(1.01);assert.throws(()=>e.recoveryFilters(),/must settle/);assert.throws(()=>e.schedulePressureAdvance(1.01,.9));e.generate(1.1);e.schedulePressureAdvance(2,.1);assert.deepEqual(e.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});
});
test('runtime emitter snapshots override stale descriptors while retaining identity and clocks',()=>{
 using q=new TrapQueue();using x=q.createStepper(settings,'x',.01);x.configureShapers({x:inputShaper('mzv',40,.1)});const old={id:'x',queueId:'xyz',member:0,settings,mode:'x' as const,rotationDistance:1,stepsPerRotation:100,shapers:{x:inputShaper('zv',80,.1)}};
 const live=recoveryEmitters([{id:'x',queue:q,stepper:x}],[old]);assert.deepEqual(live[0].shapers,x.recoveryFilters().shapers);assert.deepEqual(live[0].settings,settings);assert.notStrictEqual(live[0].settings,settings);assert.throws(()=>recoveryEmitters([{id:'x',queue:q,stepper:x}],[{...old,id:'y'}]),/Missing/);
});
test('repeated native coordinate rebuilds preserve shaped XYZE pulse positions and relative timing',async()=>{
 const reference=await nativeFilterTrace(0),rebuilt=await nativeFilterTrace(3),plain=await nativeFilterTrace(0,false);assert.deepEqual(rebuilt.filters,reference.filters);let differs=false;
 for(const axis of ['x','e'] as const){assert.equal(rebuilt.ticks[axis].length,reference.ticks[axis].length);assert(reference.ticks[axis].length>10);for(let i=0;i<reference.ticks[axis].length;i++){const [time,pos]=reference.ticks[axis][i],[actual,p]=rebuilt.ticks[axis][i];assert.equal(p,pos);assert(actual-time>=-1n&&actual-time<=1n);if(plain.ticks[axis][i]?.[0]!==time)differs=true;}}assert(differs,'trace must distinguish enabled filters from bare motion');
});
