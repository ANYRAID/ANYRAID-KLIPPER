import test from 'node:test';
import assert from 'node:assert/strict';
import {CalibrationCadence} from '../src/timing/calibration-cadence.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
test('calibration cadence retries missing boundaries and spaces successful updates',()=>{
 const cadence=new CalibrationCadence();let calls=0;const attempt=(ok:boolean)=>()=>{calls++;return ok;};
 assert.equal(cadence.run(0,attempt(false)),false);assert.equal(cadence.run(.249,attempt(true)),undefined);assert.equal(cadence.run(.25,attempt(true)),true);
 assert.equal(cadence.run(4.249,attempt(true)),undefined);assert.equal(cadence.run(4.25,attempt(true)),true);assert.equal(calls,3);
 for(const time of [4,NaN,Infinity,-1])assert.throws(()=>cadence.run(time,attempt(true)));assert.equal(calls,3);
});
test('failed calibration does not report success or postpone error propagation',()=>{
 const cadence=new CalibrationCadence(),error=new Error('calibration fault');assert.throws(()=>cadence.run(1,()=>{throw error;}),error);assert.equal(cadence.run(1,()=>true),true);assert.equal(cadence.run(2,()=>true),undefined);
});
for(const target of ['m','a'])test(`paced motion automatically recalibrates MCU ${target} across multiple periods`,async()=>{
 const f=await rebuiltFixture(false,false,false,false,true),clock=new PrintClockTimeline({offset:0,frequency:1e6}),signal=new AbortController().signal;try{
  const sync=new SecondarySync(f.options.group.session(target==='m'?'a':'m').clock.sync,f.options.group.session(target).clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
  const g=await bindRebuiltMotion({...f.options,clockTimelines:['m','a'].map(id=>({id,timeline:id===target?clock:new PrintClockTimeline({offset:0,frequency:1e6}),synchronizer:id===target?sync:undefined}))}),q=new LookAheadQueue();
  q.add(new Move(motionLimits(100,1000),[50,0,0,2],[55,0,0,2],1));await new RebuiltMotionStreamer(g).append(q.flush(),signal);await g.source.drain([],signal);
  assert(clock.status.segments>=3);for(const b of g.motion.bindings)assert.deepEqual(b.stepper.calibration,target==='m'?clock.status.calibration:{offset:0,frequency:1e6});assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,600n);assert.equal(f.stops,0);
  assert.deepEqual(g.maintainClocks(g.coordinator.status.generatedTime),{attempted:0,updated:0});await g.coordinator.shutdown();assert.throws(()=>g.maintainClocks(10));
 }finally{await f.close();}
});
