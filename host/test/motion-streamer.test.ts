import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
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
