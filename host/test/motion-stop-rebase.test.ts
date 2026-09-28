import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MotionStopConfirmation} from '../src/motion/stop-confirmation.ts';
import {CoordinateRebase} from '../src/homing/recovery.ts';
import {MotionCoordinator} from '../src/motion/coordinator.ts';
import {MoveQueueSink} from '../src/motion/move-queue-sink.ts';
import {MotionRetiredError} from '../src/motion/retired.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {recoveryFixture} from './helpers/homing-recovery.ts';
const signal=()=>new AbortController().signal;
function observe(fw:Awaited<ReturnType<typeof recoveryFixture>>['fs'][number],callback:(name:string)=>void){const decoder=new FrameDecoder();fw.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const cmd of fw.dictionary.parseFrame(frame))callback(cmd.name);});}
test('explicit stop arms a watchdog, registers every stepper, reads counters and leaves reset-required',async()=>{
 const f=await recoveryFixture();try{
  f.fs.forEach(fw=>fw.setTriggerReason(2));const stop=new MotionStopConfirmation(f.options.members),pending=stop.finish(signal());assert.strictEqual(stop.finish(signal()),pending);const result=await pending;
  assert.equal(result.hitClock,null);assert.deepEqual(result.reasons,[2,2]);assert.deepEqual(result.positions.map(p=>p.position),[100n,101n]);
  for(const fw of f.fs){const names=fw.outputs.map(o=>o.name);assert.deepEqual(names.filter(n=>n!=='config_trsync'&&n!=='config_endstop'),['trsync_trigger','trsync_start','trsync_set_timeout','stepper_stop_on_trigger','trsync_trigger','stepper_get_position']);assert.equal(fw.outputs.find(o=>o.name==='trsync_start')!.parameters.report_ticks,0);assert(!names.includes('endstop_home'));assert(!names.includes('reset_step_clock'));}assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('a previously unused trigger reason zero is accepted only before the fresh stop registration',async()=>{
 const f=await recoveryFixture(1);try{
  f.fs[0].setTriggerReason(0);observe(f.fs[0],name=>{if(name==='trsync_start')f.fs[0].setTriggerReason(2);});const result=await new MotionStopConfirmation(f.options.members).finish(signal());assert.deepEqual(result.reasons,[2]);assert.equal(f.stops,0);
 }finally{await f.close();}
});
test('coordinate rebase preserves the physical counter and the next native move starts at the forced origin',async()=>{
 const f=await recoveryFixture(1);let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  f.fs[0].setTriggerReason(2);const rebasing=new CoordinateRebase({...f.options,locate:stop=>{assert.equal(stop.hitClock,null);assert.equal(f.options.coordinator.status.retired,true);assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));return {...f.options.locate(stop),queues:[{id:'xyz',position:[50,0,0]}]};}});
  const result=await rebasing.recover(signal());motion=result.motion;const b=motion.bindings[0],t=motion.printTime;assert.equal(b.stepper.commandedPosition,50);assert.equal(b.history.status.lastPlannedPosition,100n);assert.equal(f.fs[0].motion.length,0);
  b.queue.appendRaw(new Float64Array([t,0,.01,0,50,0,0,1,0,0,10,10,0]));let position=0n;
  const sink=new MoveQueueSink([f.sessions[0].motionQueue('m0',['s0'],time=>b.stepper.clockAt(time))],async outputs=>{position=outputs[0].position;},t),coordinator=new MotionCoordinator(motion.bindings,sink,16*1024*1024,t);
  await coordinator.advance(t+.01);await f.sessions[0].waitForAcknowledgements(signal());assert.equal(position,110n);assert.equal(f.fs[0].motion.filter(m=>m.name==='queue_step').reduce((n,m)=>n+Number(m.parameters.count),0),10);assert.equal(f.stops,0);
 }finally{motion?.dispose();await f.close();}
});
test('reset waits for old generation retirement even when all physical stop readbacks are ready',async()=>{
 let release!:()=>void,read!:()=>void;const held=new Promise<void>(r=>{release=r;}),readback=new Promise<void>(r=>{read=r;}),f=await recoveryFixture(1,undefined,()=>held);let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  f.fs[0].setTriggerReason(2);f.options.bindings[0].queue.appendRaw(new Float64Array([0,0,2,0,0,0,0,0,0,0,0,0,0]));observe(f.fs[0],name=>{if(name==='stepper_get_position')read();});const advance=f.options.coordinator.advance(1.5),retired=advance.then(()=>null,error=>error),recovery=new CoordinateRebase(f.options).recover(signal());
  await readback;assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));release();assert(await retired instanceof MotionRetiredError);motion=(await recovery).motion;assert(f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));assert.equal(f.stops,0);
 }finally{release();motion?.dispose();await f.close();}
});
test('a stale watchdog or unconfirmed fresh stop prevents coordinate reset on every MCU',async()=>{
 for(const failure of ['old','fresh']){
  const f=await recoveryFixture();try{
   f.fs.forEach(fw=>fw.setTriggerReason(2));if(failure==='old')f.fs[1].setTriggerReason(4);else observe(f.fs[1],name=>{if(name==='trsync_start')f.fs[1].setTriggerReason(0);});
   await assert.rejects(new CoordinateRebase(f.options).recover(signal()));assert.equal(f.stops,2);for(const fw of f.fs)assert(!fw.outputs.some(o=>o.name==='reset_step_clock'));
  }finally{await f.close();}
 }
});
test('a completed member closing during a peer query stops all and publishes no snapshot',async()=>{
 const f=await recoveryFixture();let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  f.fs.forEach(fw=>fw.setTriggerReason(2));f.fs[1].ignore('stepper_get_position');observe(f.fs[0],name=>{if(name==='stepper_get_position')timer=setTimeout(()=>{void f.sessions[0].stop(new Error('late rebase disconnect'));},10);});
  await assert.rejects(new MotionStopConfirmation(f.options.members,500).finish(signal()),/late rebase disconnect/);assert.equal(f.stops,2);
 }finally{clearTimeout(timer);await f.close();}
});
test('invalid ownership rejects before I/O and pre-cancellation never arms a stop trigger',async()=>{
 const f=await recoveryFixture(1);try{
  const before=f.fs[0].outputs.length;assert.throws(()=>new MotionStopConfirmation([f.options.members[0],f.options.members[0]]));assert.equal(f.fs[0].outputs.length,before);
  const abort=new AbortController();abort.abort(new Error('cancel rebase'));await assert.rejects(new MotionStopConfirmation(f.options.members).finish(abort.signal),/cancel rebase/);assert.equal(f.fs[0].outputs.length,before);assert.equal(f.stops,1);
 }finally{await f.close();}
});
import {trsyncFormats} from '../src/inputs/trsync.ts';
test('an occupied response route cannot be silently reused to arm a new stop group',async()=>{
 const f=await recoveryFixture(1);try{
  f.sessions[0].subscribeResponse(trsyncFormats.state,8,{receive(){},closed(){}});const before=f.fs[0].outputs.length;
  await assert.rejects(new MotionStopConfirmation(f.options.members).finish(signal()),/subscribed/);assert.equal(f.fs[0].outputs.length,before);assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('bounded cleanup retains unresolved physical stops and late safety failures',async()=>{
 let fail!:(cause:unknown)=>void;const safety=new Promise<void>((_resolve,reject)=>{fail=reject;}),f=await recoveryFixture(1,()=>safety);
 try{
  f.fs[0].ignore('trsync_trigger');const stop=new MotionStopConfirmation(f.options.members,20);await assert.rejects(stop.finish(signal()),AggregateError);assert.equal(stop.status.cleanupPending,true);
  fail(new Error('late stop failure'));await f.sessions[0].stop().catch(()=>{});await new Promise<void>(r=>setImmediate(r));assert.equal(stop.status.cleanupPending,false);assert.equal(stop.status.cleanupErrors.length,1);
 }finally{fail(new Error('test cleanup'));await f.close();}
});
test('coordinate changes cannot silently change MCU clock calibration',async()=>{
 const f=await recoveryFixture(1);try{
  const before=f.fs[0].outputs.length;assert.throws(()=>new CoordinateRebase({...f.options,emitters:f.options.emitters.map(e=>({...e,settings:{...e.settings,frequency:1000001}}))}),/calibration differs/);assert.equal(f.fs[0].outputs.length,before);
  const rebase=new CoordinateRebase(f.options);f.options.coordinator.calibrateClock(['s0'],0,1000001);f.fs[0].setTriggerReason(2);
  await assert.rejects(rebase.recover(signal()),/calibration differs/);assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('phase observer joins stopped readback before rebase and failure prevents a new generation',async()=>{
 const {registerStoppedPositionObserver}=await import('../src/motion/stopped-position-observer.ts');
 const f=await recoveryFixture(1);let calls=0;
 const detach=registerStoppedPositionObserver(f.sessions[0],f.options.members[0].steppers[0].oid,async position=>{
  calls++;assert.equal(position,100n);assert(f.fs[0].outputs.some(o=>o.name==='stepper_get_position'));assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));throw new Error('phase read failed');
 });
 try{f.fs[0].setTriggerReason(2);await assert.rejects(new CoordinateRebase(f.options).recover(signal()),/phase read failed/);assert.equal(calls,1);assert.equal(f.stops,1);assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));}finally{detach();await f.close();}
});

test('confirmed coordinate rebase replaces carriage transforms without moving or losing counters',async()=>{
 const f=await recoveryFixture(1);let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
 try{
  f.fs[0].setTriggerReason(2);const transform={xScale:-1,xOffset:180,yScale:1,yOffset:0};
  const rebase=new CoordinateRebase({...f.options,carriageTransforms:[{id:'s0',transform}],locate:stop=>({...f.options.locate(stop),queues:[{id:'xyz',position:[50,0,0]}]})});
  transform.xOffset=999;motion=(await rebase.recover(signal())).motion;
  const b=motion.bindings[0],t=motion.printTime;assert.equal(b.stepper.commandedPosition,130);assert.equal(b.history.status.lastPlannedPosition,100n);assert.equal(f.fs[0].motion.length,0);
  assert.equal(b.stepper.recoveryFilters().carriage!.xOffset,180);
  b.queue.appendRaw(new Float64Array([t,0,.01,0,50,0,0,1,0,0,10,10,0]));b.stepper.generate(t+.01);assert.equal(b.stepper.flush().position,90n);assert.equal(f.stops,0);
 }finally{motion?.dispose();await f.close();}
});
test('carriage replacement preflight rejects unknown, duplicate and nonfinite owners before IO',async()=>{
 const f=await recoveryFixture(1);try{
  const transform={xScale:-1,xOffset:180,yScale:1,yOffset:0},before=f.fs[0].outputs.length;
  for(const carriageTransforms of [[{id:'missing',transform}],[{id:'s0',transform},{id:'s0',transform}],[{id:'s0',transform:{...transform,xScale:NaN}}]])assert.throws(()=>new CoordinateRebase({...f.options,carriageTransforms}),/carriage/);
  assert.equal(f.fs[0].outputs.length,before);assert.equal(f.options.coordinator.status.retired,false);
 }finally{await f.close();}
});
test('unrepresentable carriage replacement stops safely and sends no clock reset',async()=>{
 const f=await recoveryFixture(1);try{
  f.fs[0].setTriggerReason(2);
  await assert.rejects(new CoordinateRebase({...f.options,carriageTransforms:[{id:'s0',transform:{xScale:1,xOffset:1e30,yScale:1,yOffset:0}}]}).recover(signal()),/resolution/);
  assert.equal(f.stops,1);assert(!f.fs[0].outputs.some(o=>o.name==='reset_step_clock'));
 }finally{await f.close();}
});

test('two MCU carriage mode proposals rebuild together and emit only newly requested motion',async()=>{
 const {planCarriageMode}=await import('../src/kinematics/dual-carriage.ts');
 const {nativeCarriageTransforms}=await import('../src/kinematics/dual-carriage-projection.ts');
 for(const mode of ['PRIMARY','COPY','MIRROR'] as const){
  const f=await recoveryFixture(2);let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
  try{
   const initial=[{mode:'PRIMARY',scale:1,offset:0},{mode:'INACTIVE',scale:0,offset:180}] as const,topology={kind:'cartesian',axis:0} as const;
   const old=nativeCarriageTransforms(topology,initial);f.options.bindings.forEach((b,i)=>b.stepper.configureCarriage(old[i]));f.fs.forEach(fw=>fw.setTriggerReason(2));
   const plan=planCarriageMode(initial,0,1,mode,true),next=nativeCarriageTransforms(topology,plan.carriages);
   motion=(await new CoordinateRebase({...f.options,carriageTransforms:next.map((transform,i)=>({id:`s${i}`,transform})),locate:stop=>({...f.options.locate(stop),queues:[{id:'xyz',position:[plan.position,0,0]}]})}).recover(signal())).motion;
   assert.deepEqual(motion.bindings.map(b=>b.stepper.commandedPosition),[0,180]);assert.deepEqual(motion.bindings.map(b=>b.stepper.flush().position),[100n,101n]);assert(f.fs.every(fw=>fw.motion.length===0));
   const t=motion.printTime;motion.queues[0].queue.appendRaw(new Float64Array([t,0,.01,0,plan.position,0,0,1,0,0,10,10,0]));
   for(const b of motion.bindings)b.stepper.generate(t+.01);
   assert.deepEqual(motion.bindings.map(b=>b.stepper.flush().position),mode==='PRIMARY'?[100n,111n]:mode==='COPY'?[110n,111n]:[110n,91n]);
  }finally{motion?.dispose();await f.close();}
 }
});
