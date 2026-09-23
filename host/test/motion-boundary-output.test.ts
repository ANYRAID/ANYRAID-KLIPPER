import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
import {GenerationPWMOutput} from '../src/outputs/generation-pwm.ts';
import {ScheduledCoolingFan} from '../src/outputs/fan.ts';
import {FanBoundaryTimeline} from '../src/outputs/fan-boundaries.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {Move,LookAheadQueue,motionLimits} from '../src/motion/lookahead.ts';
import {markMoveEnd} from '../src/motion/boundary-markers.ts';
import {inputShaper} from '../src/motion/shaper.ts';
const signal=()=>new AbortController().signal;
async function fixture(filtered=false,kickStartTime=0){
 const f=await rebuiltFixture(false,false,true);
 try{
  const group=f.options.group,stepper=f.options.motion.bindings[0].stepper,session=group.session('m');
  const pwm=new GenerationPWMOutput(f.fanPlan!,session.dictionary,group.commandQueue('m'),group.commandQueue('m'),t=>stepper.clockAt(t),c=>stepper.printTimeAtClock(c)),fan=new ScheduledCoolingFan(pwm,{kickStartTime,minimumScheduleTime:.001});await fan.start(signal());const timeline=new FanBoundaryTimeline(fan);
  const g=await bindRebuiltMotion({...f.options,boundaryOutput:{output:timeline,member:0}});
  if(filtered){g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});g.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}
  return {f,g,fan,timeline,pwm,stream:new RebuiltMotionStreamer(g),writes:()=>f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation'),close:async()=>{await f.close();await timeline.stop();}};
 }catch(error){await f.close();throw error;}
}
function path(id:number,end=52){const q=new LookAheadQueue(),m=new Move(motionLimits(100,100,5,0),[50,0,0,2],[end,0,0,2.1],10);markMoveEnd(m,id);q.add(m);return q.flush();}
for(const filtered of [false,true])test(`source delivers exact final endpoint PWM before drain clock wait (filtered=${filtered})`,async()=>{
 const t=await fixture(filtered);try{
  assert.throws(()=>t.g.source.retireProducer(),/output ownership/);const id=t.timeline.register(.5);await t.stream.append(path(id),signal());assert.equal(t.writes().length,0);
  const endpoint=t.g.source.status.sourceTime,wait=t.g.group.waitForMotionClocks.bind(t.g.group);let waited=false;t.g.group.waitForMotionClocks=async(...args)=>{assert.equal(t.writes().length,1);waited=true;return wait(...args);};await t.g.source.drain([],signal());assert(waited);assert.equal(t.writes().length,1);assert.equal(t.writes()[0].parameters.value,128);assert.equal(Number(t.writes()[0].parameters.clock),Number(BigInt.asUintN(32,t.g.motion.bindings[0].stepper.clockAt(endpoint))));
  assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,300n);assert.equal(t.g.motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('active pause invalidates unsent endpoint time and resumed source emits only its new time',async()=>{
 const t=await fixture(true);try{
  const id=t.timeline.register(.5),running=t.stream.append(path(id,65),signal());let old=0;const deliver=t.timeline.deliver.bind(t.timeline);t.timeline.deliver=async(b,h,s)=>{old ||= b.find(x=>x.id===id)?.time??0;return deliver(b,h,s);};
  const deadline=performance.now()+3000;while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline);await delay(2);}
  const paused=await t.stream.requestPause();assert(paused.position[0]<65);assert.equal(t.writes().length,0);await t.stream.resume(()=>{});await running;const end=t.g.source.status.sourceTime;await t.g.source.drain([],signal());assert(old>0);assert(end>old);assert.equal(t.writes().length,1);assert.equal(Number(t.writes()[0].parameters.clock),Number(BigInt.asUintN(32,t.g.motion.bindings[0].stepper.clockAt(end))));assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,1600n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('output delivery failure stops native motion and idle group fault stops the fan',async()=>{
 for(const idle of [false,true]){
  const t=await fixture();try{
   if(idle){await t.g.group.stop(new Error('idle MCU failure'));assert.equal(t.timeline.status.stopped,true);assert.equal(t.fan.status.phase,'stopped');}
   else{t.timeline.deliver=async()=>{throw new Error('output ACK failed');};const id=t.timeline.register(.5);await assert.rejects(t.stream.append(path(id),signal()),/output ACK failed/);assert.equal(t.timeline.status.stopped,true);assert.equal(t.g.source.status.failed,true);}
   assert.equal(t.f.stops,1);
  }finally{await t.close();}
 }
});
test('cancellation during output ACK stops both owners and late callback cannot resume motion',async()=>{
 const t=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),cancel=new AbortController();
 try{
  t.timeline.deliver=async()=>{entered.resolve();await release.promise;};const running=t.stream.append(path(t.timeline.register(.5)),cancel.signal),failed=assert.rejects(running,/cancel output/);await entered.promise;
  cancel.abort(new Error('cancel output'));await failed;assert.equal(t.timeline.status.stopped,true);assert.equal(t.g.source.status.failed,true);assert.equal(t.f.stops,1);const state=t.g.coordinator.status,position=t.g.motion.bindings[0].history.status.lastPlannedPosition;release.resolve();await delay(10);assert.deepEqual(t.g.coordinator.status,state);assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,position);
 }finally{release.resolve();await t.close();}
});
test('dense fan endpoints preserve rolling motion lead without changing PWM timestamps',async()=>{
 const t=await fixture(true);try{
  const q=new LookAheadQueue();for(let i=0;i<10;i++){const m=new Move(motionLimits(100,1000),[50+i*.2,0,0,2],[50+(i+1)*.2,0,0,2],10);markMoveEnd(m,t.timeline.register(i%2?.5:.25));q.add(m);}
  const moves=q.flush();await t.stream.append(moves,signal());const end=t.g.source.status.sourceTime;await t.g.source.drain([],signal());assert.equal(t.writes().length,10);assert.deepEqual(t.writes().map(m=>m.parameters.value),Array.from({length:10},(_,i)=>i%2?128:64));assert.equal(Number(t.writes().at(-1)!.parameters.clock),Number(BigInt.asUintN(32,t.g.motion.bindings[0].stepper.clockAt(end))));assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,300n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
for(const filtered of [false,true])test(`drain waits for the final kick tail MCU tick and subsequent motion gets fresh time (filtered=${filtered})`,async()=>{
 const t=await fixture(filtered,.15);try{
  await t.stream.append(path(t.timeline.register(.5)),signal());const endpoint=t.g.source.status.sourceTime,stepper=t.g.motion.bindings[0].stepper;
  await t.g.source.drain([],signal());assert.deepEqual(t.writes().map(m=>m.parameters.value),[255,128]);const tail=stepper.clockAt(endpoint+.15);assert.equal(Number(t.writes()[1].parameters.clock),Number(BigInt.asUintN(32,tail)));assert(t.g.members[0].session.clock.sync.lastClock>tail);assert.equal(t.fan.status.pending,0);assert.equal(t.timeline.status.pending,0);
  const q=new LookAheadQueue(),m=new Move(motionLimits(100,1000),[52,0,0,2.1],[53,0,0,2.1],10);markMoveEnd(m,t.timeline.register(.25));q.add(m);await t.stream.append(q.flush(),signal());const end=t.g.source.status.sourceTime;assert(end>endpoint+.15);await t.g.source.drain([],signal());assert.deepEqual(t.writes().map(m=>m.parameters.value),[255,128,64]);assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,400n);assert.equal(t.g.motion.bindings[1].history.status.lastPlannedPosition,30n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('cancellation while awaiting tail MCU time cannot publish a completed drain',async()=>{
 const t=await fixture(false,.5),cancel=new AbortController(),entered=Promise.withResolvers<void>();try{
  await t.stream.append(path(t.timeline.register(.5)),signal());const settle=t.timeline.settleScheduled.bind(t.timeline);t.timeline.settleScheduled=async s=>{const until=await settle(s);entered.resolve();return until;};
  const pending=t.g.source.drain([],cancel.signal),rejected=assert.rejects(pending,/cancel tail clock/);await entered.promise;cancel.abort(new Error('cancel tail clock'));await rejected;assert.equal(t.g.source.status.paused,false);assert.equal(t.g.source.status.failed,true);assert.equal(t.timeline.status.stopped,true);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
test('a boundary added after rolling submission uses the owned source endpoint without new geometry',async()=>{
 const t=await fixture(true);try{
  const q=new LookAheadQueue();q.add(new Move(motionLimits(100,1000),[50,0,0,2],[52,0,0,2],10));await t.stream.append(q.flush(),signal());const end=t.g.source.status.sourceTime,count=t.g.source.status.bufferedMoves;t.g.source.markBoundary(t.timeline.register(.5));assert.equal(t.g.source.status.bufferedMoves,count);assert.equal(t.g.source.status.sourceTime,end);
  await t.g.source.drain([],signal());assert.equal(t.writes().length,1);assert.equal(Number(t.writes()[0].parameters.clock),Number(BigInt.asUintN(32,t.g.motion.bindings[0].stepper.clockAt(end))));assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,300n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
