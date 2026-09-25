import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
import {inputShaper} from '../src/motion/shaper.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
const signal=()=>new AbortController().signal;
async function fixture(filtered=false){const f=await rebuiltFixture();try{const g=await bindRebuiltMotion(f.options);if(filtered){g.motion.bindings[0].stepper.configureShapers({x:inputShaper('mzv',40,.1)});g.motion.bindings[1].stepper.configurePressureAdvance(.05,.04);}return {f,g,stream:new RebuiltMotionStreamer(g),close:()=>f.close()};}catch(error){await f.close();throw error;}}
function path(){const q=new LookAheadQueue();q.add(new Move(motionLimits(100,100,5,0),[50,0,0,2],[80,0,0,3],10));return q.flush();}
async function started(t:Awaited<ReturnType<typeof fixture>>){const deadline=performance.now()+3000;while(!t.f.fw.motion.some(m=>m.name==='queue_step')){assert(performance.now()<deadline,'stream did not start');await delay(2);}}
for(const filtered of [false,true])test(`active append brakes, remains pending while paused and resumes its owned suffix (filtered=${filtered})`,async()=>{
 const t=await fixture(filtered);try{
  let done=false;const running=t.stream.append(path(),signal()).then(()=>{done=true;});await started(t);const start=performance.now(),pause=t.stream.requestPause();assert.equal(pause,t.stream.requestPause());const stopped=await pause;
  assert(performance.now()-start<1800);assert(stopped.position[0]>50&&stopped.position[0]<80);assert(Object.isFrozen(stopped.position));assert.equal(t.stream.status.pause,'paused');assert.equal(t.g.source.status.paused,true);assert.equal(done,false);
  const count=t.f.fw.motion.length,position=t.g.motion.bindings[0].history.status.lastPlannedPosition;await delay(120);assert.equal(t.f.fw.motion.length,count);assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,position);await assert.rejects(t.stream.append([],signal()),/busy/);
  let checked=0;t.stream.resume(m=>{checked++;assert(m.startPos[0]>=stopped.position[0]);m.limitSpeed(9,100);});await assert.rejects(t.stream.requestPause(),/resuming/);await running;assert(checked>0);await t.g.source.drain([],signal());assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,3100n);assert.equal(t.g.motion.bindings[1].history.status.lastPlannedPosition,120n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('closing lookahead tail is transferred exactly once and invalid incomplete requests do not stop motion',async()=>{
 const t=await fixture();try{
  const q=new LookAheadQueue();for(let i=0;i<40;i++)q.add(new Move(motionLimits(100,100),[50+i*.5,0,0,2],[50+(i+1)*.5,0,0,2],10));const prefix=q.flush(true),tail=q.flush();assert(prefix.length&&tail.length&&prefix.at(-1)!.profile!.endV>0);
  const running=t.stream.append(prefix,signal());await started(t);await assert.rejects(t.stream.requestPause(),/complete lookahead tail/);assert.equal(t.f.stops,0);
  const paused=t.stream.requestPause(tail);tail.at(-1)!.endPos[0]=999;await paused;t.stream.resume(()=>{});await running;await t.g.source.drain([],signal());assert.equal(t.g.source.status.position[0],70);assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('cancellation while paused rejects the held append and stops the group',async()=>{
 const t=await fixture(true),cancel=new AbortController();try{const running=t.stream.append(path(),cancel.signal),rejected=assert.rejects(running,/cancel paused/);await started(t);await t.stream.requestPause();cancel.abort(new Error('cancel paused'));await rejected;assert.equal(t.f.stops,1);assert.equal(t.stream.status.busy,false);assert.throws(()=>t.stream.resume(()=>{}),/not awaiting/);}finally{await t.close();}
});
test('resume revalidation failure cannot submit any retained suffix',async()=>{
 const t=await fixture();try{const running=t.stream.append(path(),signal()),rejected=assert.rejects(running,/extruder cold/);await started(t);await t.stream.requestPause();const count=t.f.fw.motion.length;t.stream.resume(()=>{throw new Error('extruder cold');});await rejected;assert.equal(t.f.fw.motion.length,count);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('explicit transaction deadline still expires while paused',async()=>{
 const t=await fixture();try{const running=t.stream.append(path(),signal(),1800),rejected=assert.rejects(running,/timed out/);await started(t);await t.stream.requestPause();await rejected;assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('group failure while paused rejects the held append without waiting for user resume',async()=>{
 const t=await fixture();try{const running=t.stream.append(path(),signal()),rejected=assert.rejects(running,/MCU group is not ready/);await started(t);await t.stream.requestPause();const count=t.f.fw.motion.length;await t.g.group.stop(new Error('lost MCU'));await rejected;assert.equal(t.f.fw.motion.length,count);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('an empty rolling flush can pause at the completed endpoint without losing its acknowledgement',async()=>{
 const t=await fixture();try{
  const q=new LookAheadQueue();q.add(new Move(motionLimits(100,100),[50,0,0,2],[51,0,0,2],10));await t.stream.append(q.flush(),signal());
  const running=t.stream.append([],signal()),pause=t.stream.requestPause();const stopped=await pause;assert.equal(stopped.position[0],51);t.stream.resume(()=>{});await running;assert.equal(t.g.source.status.paused,true);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('failed append rejects new pause requests while asynchronous stop cleanup is pending',async()=>{
 const t=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),cause=new Error('injected stream failure');
 const stop=t.g.drain.stop.bind(t.g.drain);
 t.g.source.flushThrough=async()=>{throw cause;};
 t.g.drain.stop=async(reason)=>{entered.resolve();await release.promise;await stop(reason);};
 let rejected:Promise<void>|undefined;
 try{
  rejected=assert.rejects(t.stream.append(path(),signal()),error=>error===cause);await entered.promise;assert.equal(t.stream.status.busy,true);
  await assert.rejects(t.stream.requestPause(),/No active motion stream/);
 }finally{release.resolve();await rejected;await t.close();}
 assert.equal(t.stream.status.busy,false);assert.equal(t.f.stops,1);
});
test('pressure history backpressure preserves a dense owned path across pause and resume',async()=>{
 const t=await fixture(true);try{
  const q=new LookAheadQueue(),limits=motionLimits(100,100,5,0);
  for(let i=0;i<200;i++)q.add(new Move(limits,[50+i*.1,0,0,2+i*.01],[50+(i+1)*.1,0,0,2+(i+1)*.01],10));
  const moves=q.flush();for(let i=0;i<moves.length;i++)moves[i].pressureBoundaries=[{stepper:t.g.motion.bindings[1].id,advance:i%2?.05:.1}];
  const running=t.stream.append(moves,signal());await started(t);const stopped=await t.stream.requestPause();assert(stopped.position[0]>50&&stopped.position[0]<70);
  // The stream owns both the geometry and parameter suffix across the await.
  moves.at(-1)!.endPos[0]=999;moves.at(-1)!.pressureBoundaries=[{stepper:t.g.motion.bindings[1].id,advance:.4}];
  t.stream.resume(()=>{});await running;await t.g.source.drain([],signal());
  assert.equal(t.g.source.status.position[0],70);assert.equal(t.g.motion.bindings[0].history.status.lastPlannedPosition,2100n);assert.equal(t.g.motion.bindings[1].history.status.lastPlannedPosition,220n);
  assert.deepEqual(t.g.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
