import {test} from 'node:test';
import assert from 'node:assert/strict';
import {homingSetPositionOffsets} from '../src/homing/position-offsets.ts';
import {HomingMoveExecution} from '../src/homing/move-execution.ts';
import {nativeHomingFixture} from './helpers/homing-move-execution.ts';
const signal=()=>new AbortController().signal;
test('exhausted homing confirms each actual MCU endpoint before stopping when its estimate leads firmware',async()=>{
 const x=await nativeHomingFixture(2);let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;
 try{
  for(const [i,session] of x.f.sessions.entries()){
   const estimated=session.clock.sync.getClock.bind(session.clock.sync);
   session.clock.sync.getClock=time=>estimated(time)+20000n;
   x.f.fs[i].setTriggerReason(3,8);x.f.fs[i].setStepperPosition(1,300);
  }
  using move=new HomingMoveExecution(x.options);result=await move.run(signal());
  assert.equal(result.drip.reason,'exhausted');assert.deepEqual(result.missingHits,[0]);
  assert.deepEqual(result.offsets.map(p=>p.trigger),[300n,300n]);
  for(const position of result.stop.positions)assert(position.observedClock>=result.triggerClocks[0][position.member]);
  assert.equal(x.f.stops,0);
 }finally{result?.motion.dispose();await x.close();}
});
test('missing actual endpoint observation keeps the original deadline and cannot reset coordinates', {timeout:5000},async()=>{
 const x=await nativeHomingFixture();
 try{
  x.f.fs[0].setTriggerReason(3,8);x.f.fs[0].ignore('get_uptime');
  using move=new HomingMoveExecution({...x.options,timeoutMs:2000});
  await assert.rejects(move.run(signal()),/Homing move timed out/);
  assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));
 }finally{await x.close();}
});
test('trigger device output precedes recovery and its failure prevents coordinate reset',async()=>{
 const x=await nativeHomingFixture();let timer:ReturnType<typeof setTimeout>|undefined;
 try{let called=0;using move=new HomingMoveExecution({...x.options,onTriggered:async()=>{called++;assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));throw Error('probe stow failed');}});timer=setTimeout(()=>x.hit(0),(x.lead+.025)*1000);await assert.rejects(move.run(signal()),/probe stow failed/);assert.equal(called,1);assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));}finally{clearTimeout(timer);await x.close();}
});
test('cancellation during trigger output joins stop and late completion cannot reset coordinates',async()=>{
 const x=await nativeHomingFixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),abort=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
 try{using move=new HomingMoveExecution({...x.options,onTriggered:async()=>{entered.resolve();await release.promise;}});timer=setTimeout(()=>x.hit(0),(x.lead+.025)*1000);const pending=move.run(abort.signal),rejected=assert.rejects(pending,/cancel stow/);await entered.promise;abort.abort(Error('cancel stow'));await rejected;release.resolve();await new Promise(r=>setImmediate(r));assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));}finally{release.resolve();clearTimeout(timer);await x.close();}
});
test('one owner arms native triggers, archives generated history, reads back and restores the motion generation',async()=>{
 const x=await nativeHomingFixture();let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  let triggerOutputs=0;using move=new HomingMoveExecution({...x.options,onTriggered:async()=>{triggerOutputs++;assert.equal(x.f.options.coordinator.status.retired,false);}});timer=setTimeout(()=>x.hit(0),(x.lead+.025)*1000);
  const pending=move.run(signal());assert.strictEqual(move.run(signal()),pending);result=await pending;
  assert.equal(triggerOutputs,1);assert.equal(result.drip.reason,'triggered');assert.deepEqual(result.missingHits,[]);assert.equal(result.offsets[0].trigger,20n);assert.equal(result.offsets[0].halt,23n);assert.equal(result.offsets[0].overshoot,3n);
  assert.equal(result.triggerClocks[0][0],result.stop.groups[0].hitClock);assert(x.history[0].status.rows>0);assert.equal(x.f.options.coordinator.status.retired,true);assert.equal(result.motion.bindings[0].history.status.lastPlannedPosition,23n);assert(Math.abs(result.motion.bindings[0].stepper.commandedPosition-3.03)<1e-12);assert.equal(x.f.stops,0);
 }finally{clearTimeout(timer);result?.motion.dispose();await x.close();}
});
test('coupled MCU trigger clocks use each calibrated domain rather than copying primary ticks',async()=>{
 const x=await nativeHomingFixture(2,false,[1e6,1000123.5]);let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  using move=new HomingMoveExecution(x.options);timer=setTimeout(()=>x.hit(0),(x.lead+.025)*1000);result=await move.run(signal());
  assert.notEqual(result.triggerClocks[0][0],result.triggerClocks[0][1]);assert.deepEqual(result.offsets.map(p=>p.trigger),[20n,20n]);assert.equal(x.f.stops,0);
 }finally{clearTimeout(timer);result?.motion.dispose();await x.close();}
});
test('full travel without a hit recovers against endpoint history without inventing a hit',async()=>{
 const x=await nativeHomingFixture();let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;
 try{
  x.f.fs[0].setTriggerReason(3,8);x.f.fs[0].setStepperPosition(1,300);using move=new HomingMoveExecution({...x.options,onTriggered:async()=>{assert.fail('no hit must not issue trigger device output');}});result=await move.run(signal());
  assert.equal(result.drip.reason,'exhausted');assert.equal(result.stop.groups[0].hitClock,null);assert.deepEqual(result.missingHits,[0]);assert.throws(()=>homingSetPositionOffsets(result!.stop,result!.histories,result!.triggerClocks),/did not trigger/);assert.equal(result.offsets[0].trigger,300n);assert.equal(result.offsets[0].overshoot,0n);assert.equal(x.f.stops,0);
 }finally{result?.motion.dispose();await x.close();}
});
test('independent endstop groups retain different hit times through the unified native lifecycle',async()=>{
 const x=await nativeHomingFixture(2,true);let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined;const timers:ReturnType<typeof setTimeout>[]=[];
 try{
  using move=new HomingMoveExecution(x.options);timers.push(setTimeout(()=>x.hit(0),225),setTimeout(()=>x.hit(1,1,.04),250));result=await move.run(signal());
  assert.equal(result.stop.groups.length,2);assert.deepEqual(result.offsets.map(p=>[p.trigger,p.halt]),[[20n,23n],[40n,44n]]);assert.equal(x.f.stops,0);
 }finally{timers.forEach(clearTimeout);result?.motion.dispose();await x.close();}
});
test('pre-cancellation stops the complete move without arming or resetting devices',async()=>{
 const x=await nativeHomingFixture();try{
  using move=new HomingMoveExecution(x.options);const abort=new AbortController();abort.abort(new Error('cancel move'));await assert.rejects(move.run(abort.signal),/cancel move/);assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='trsync_start'||o.name==='reset_step_clock'));
 }finally{await x.close();}
});
test('a calibration change after construction fails before physical arming',async()=>{
 const x=await nativeHomingFixture();try{
  using move=new HomingMoveExecution(x.options);x.f.options.coordinator.calibrateClock(['s0'],0,1000001);await assert.rejects(move.run(signal()),/calibration changed/);assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='trsync_start'||o.name==='reset_step_clock'));
 }finally{await x.close();}
});
test('coordinate reconstruction failure prevents every reset and stops all devices',async()=>{
 const x=await nativeHomingFixture();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  using move=new HomingMoveExecution({...x.options,locate:()=>{throw new Error('invalid inverse position');}});timer=setTimeout(()=>x.hit(0),225);await assert.rejects(move.run(signal()),/invalid inverse position/);assert.equal(x.f.stops,1);assert(!x.f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));
 }finally{clearTimeout(timer);await x.close();}
});
test('invalid constructor ownership frees dispatches without stopping healthy sessions',async()=>{
 const x=await nativeHomingFixture();try{
  assert.throws(()=>new HomingMoveExecution({...x.options,histories:[]}),/history/);
  assert.throws(()=>new HomingMoveExecution({...x.options,emitters:x.options.emitters.map(e=>({...e,settings:{...e.settings,queueStepTag:e.settings.queueStepTag+1}}))}),/emitter/);
  await new Promise<void>(r=>setImmediate(r));assert.equal(x.f.stops,0);assert(!x.f.fs[0].outputs.some(o=>o.name==='trsync_start'));
  const move=new HomingMoveExecution(x.options);move.dispose();await assert.rejects(move.run(signal()),/disposed/);assert.equal(x.f.stops,0);
 }finally{await x.close();}
});

test('active homing pins the initial history through readback and releases it after retirement',async()=>{
 const x=await nativeHomingFixture();let result:Awaited<ReturnType<HomingMoveExecution['run']>>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const history=x.history[0],before=history.status;using move=new HomingMoveExecution(x.options);
  timer=setTimeout(()=>x.hit(0),(x.lead+.025)*1000);const pending=move.run(signal());
  assert.equal(history.pruneBefore(before.throughClock),0);assert.equal(history.status.fromClock,before.fromClock);
  result=await pending;assert.equal(result.offsets[0].trigger,20n);assert.equal(result.offsets[0].overshoot,3n);
  const end=history.status.throughClock;history.pruneBefore(end);assert.equal(history.status.fromClock,end);
 }finally{clearTimeout(timer);result?.motion.dispose();await x.close();}
});
