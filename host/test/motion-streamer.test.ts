import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
import {SecondarySync} from '../src/timing/secondary-sync.ts';
test('owned motion calibration selects all MCU emitters within retained source and pacing limits',async()=>{
 const f=await rebuiltFixture(false,false,false,false,true),clock=new PrintClockTimeline({offset:0,frequency:1e6});try{
  const sync=new SecondarySync(f.options.group.session('a').clock.sync,f.options.group.session('m').clock.sync,0,{offset:0,frequency:1e6,syncTime:0});
  const g=await bindRebuiltMotion({...f.options,clockTimelines:[{id:'m',timeline:clock,synchronizer:sync},{id:'a',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]}),stream=new RebuiltMotionStreamer(g),original=g.source.flushThrough.bind(g.source);let updated=false;
  assert.equal(g.calibrateMotionClock('m',g.coordinator.status.generatedTime+1),false);assert.throws(()=>g.calibrateMotionClock('a',10),/motion MCU/);
  g.source.flushThrough=async(until,...args)=>{
   const result=await original(until,...args);if(!updated){const before=g.coordinator.status;
    assert.equal(g.calibrateMotionClock('m',before.generatedTime),false);
    const local=g.group.session('m').clock.sync,getClock=local.getClock,generate=g.coordinator.generateCalibrationBoundary,oldMapping=clock.status.calibration;
    try{
     local.getClock=()=>clock.clockAt(before.generatedTime+.1);assert.equal(g.calibrateMotionClock('m',before.generatedTime+.005),false);assert.equal(g.coordinator.status.generatedTime,before.generatedTime);local.getClock=getClock;
     g.coordinator.generateCalibrationBoundary=until=>{generate.call(g.coordinator,until);local.getClock=()=>clock.clockAt(until+.1);};
     assert.equal(g.calibrateMotionClock('m',before.generatedTime+.005),false);assert.deepEqual(clock.status.calibration,oldMapping);
    }finally{local.getClock=getClock;g.coordinator.generateCalibrationBoundary=generate;}
    assert(g.calibrateMotionClock('m',before.generatedTime+.005));updated=true;
    assert(g.coordinator.status.generatedTime<=before.generatedTime+.005);assert.equal(g.coordinator.status.committedTime,before.committedTime);
    for(const b of g.motion.bindings)assert.deepEqual(b.stepper.calibration,clock.status.calibration);
   }return result;
  };
  await stream.append(trajectory(),signal());await g.source.drain([],signal());assert(updated);assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(f.stops,0);await g.coordinator.shutdown();
 }finally{await f.close();}
});
test('paced stream accepts a shared calibration between windows and retains old sampled time',async()=>{
 const f=await rebuiltFixture(),clock=new PrintClockTimeline({offset:0,frequency:1e6});try{
  const g=await bindRebuiltMotion({...f.options,clockTimelines:[{id:'m',timeline:clock}]}),stream=new RebuiltMotionStreamer(g),original=g.source.flushThrough.bind(g.source);let updated=false;
  g.source.flushThrough=async(until,...args)=>{
   const result=await original(until,...args);if(!updated){
    const limit=g.source.status.sourceTime-Math.max(...g.motion.bindings.map(b=>b.stepper.scanWindow.future))-.001;
    const plan=clock.planCalibration(g.coordinator.status.generatedTime,limit,1000100);assert(plan);
    await g.coordinator.advanceWindow(plan.time,g.coordinator.status.committedTime);
    const old=g.members[0].session.clock.sync.lastClock,before=clock.printTimeAtClock(old);
    clock.calibrateMotion(plan.tick,1000100,g.coordinator,g.motion.bindings.map(b=>b.id));updated=true;
    assert.equal(g.clockMembers[0].stepper.printTimeAtClock(old),before);g.assertClockCalibration();
   }return result;
  };
  await stream.append(trajectory(),signal());await g.source.drain([],signal());assert(updated);assert.equal(g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(f.stops,0);await g.coordinator.shutdown();
 }finally{await f.close();}
});
for(const shared of [false,true])test(`stream rejects a native-only calibration (shared=${shared})`,async()=>{
 const f=await rebuiltFixture();try{
  const g=await bindRebuiltMotion({...f.options,clockTimelines:shared?[{id:'m',timeline:new PrintClockTimeline({offset:0,frequency:1e6})}]:undefined}),stream=new RebuiltMotionStreamer(g),before=f.fw.motion.length;
  g.coordinator.calibrateClock(['x'],0,1000001);await assert.rejects(stream.append(trajectory(),signal()),/calibration changed/);assert.equal(f.fw.motion.length,before);assert.equal(f.stops,1);
 }finally{await f.close();}
});
const signal=()=>new AbortController().signal;
function trajectory(start=50,count=20){const q=new LookAheadQueue();for(let i=0;i<count;i++)q.add(new Move(motionLimits(100,1000),[start+i,0,0,2],[start+i+1,0,0,2],20));return q.flush();}
async function fixture(shaped=false){const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);if(shaped)g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});return {f,g,stream:new RebuiltMotionStreamer(g),close:()=>f.close()};}catch(error){await f.close();throw error;}}
for(const shaped of [false,true])test(`paced native stream limits its horizon and preserves final steps (shaped=${shaped})`,async()=>{
 const t=await fixture(shaped);try{
  const original=t.g.source.flushThrough.bind(t.g.source);let commits=0;
  t.g.source.flushThrough=async(until,...args)=>{commits++;const x=t.g.motion.bindings[0].stepper,now=x.printTimeAtClock(t.g.members[0].session.clock.sync.getClock(serialClock.now()));assert(until<=now+.5+x.scanWindow.future+.00301);return original(until,...args);};
  const moves=trajectory(),running=t.stream.append(moves,signal());moves.at(-1)!.endPos[0]=999;await running;
  assert(commits>=3);assert.equal(t.g.source.status.paused,false);assert.equal(t.g.source.status.position[0],70);assert(t.g.coordinator.status.committedTime<t.g.source.status.sourceTime);
  await t.g.source.drain([],signal());assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(t.g.source.status.bufferedMoves,0);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('stream cancellation during pacing stops every transport without accepting the suffix',async()=>{
 const t=await fixture(),a=new AbortController();const timer=setTimeout(()=>a.abort(new Error('cancel pacing')),80);
 try{await assert.rejects(t.stream.append(trajectory(),a.signal),/cancel pacing/);assert.equal(t.f.stops,1);assert.equal(t.g.group.status.state,'stopped');assert.equal(t.stream.status.busy,false);assert(t.g.motion.bindings[0].history.status.lastPlannedPosition<2100n);}finally{clearTimeout(timer);await t.close();}
});
test('late invalid batch is rejected before any native prefix is submitted',async()=>{
 const t=await fixture();try{const moves=trajectory();moves.at(-1)!.startPos[0]=0;const before=t.f.fw.motion.length;await assert.rejects(t.stream.append(moves,signal()),/discontinuous/);assert.equal(t.f.fw.motion.length,before);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('a stalled active producer faults instead of silently rescheduling continuous motion',async()=>{
 const t=await fixture();try{await t.stream.append(trajectory(50,2),signal());await delay(400);await assert.rejects(t.stream.append(trajectory(52,2),signal()),/lead exhausted/);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('an unused or fully drained source starts with fresh lead after an idle delay',async()=>{
 const t=await fixture();try{await delay(300);await t.stream.append(trajectory(50,2),signal());await t.g.source.drain([],signal());await delay(300);await t.stream.append(trajectory(52,2),signal());await t.g.source.drain([],signal());assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,500n);assert.equal(t.f.stops,0);}finally{await t.close();}
});
test('changed filter windows cannot invalidate a running producer scheduling contract',async()=>{
 const t=await fixture();try{t.g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});const before=t.f.fw.motion.length;await assert.rejects(t.stream.append(trajectory(),signal()),/filter window changed/);assert.equal(t.f.fw.motion.length,before);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('an explicit stream transaction deadline remains enforced while clocks are healthy',async()=>{
 const t=await fixture();try{await assert.rejects(t.stream.append(trajectory(),signal(),50),/timed out/);assert.equal(t.f.stops,1);assert(t.g.motion.bindings[0].history.status.lastPlannedPosition<2100n);}finally{await t.close();}
});
test('a healthy 32-second move is not mistaken for an I/O stall',{timeout:45000},async()=>{
 const t=await fixture();try{
  const q=new LookAheadQueue();q.add(new Move(motionLimits(100,1000),[50,0,0,2],[70,0,0,2],.625));const started=performance.now();
  await t.stream.append(q.flush(),signal());assert(performance.now()-started>30000);await t.g.source.drain([],signal());assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
