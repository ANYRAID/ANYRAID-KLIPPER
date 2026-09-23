import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLinearFixture,nativeStreamStarted} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
const signal=()=>new AbortController().signal;
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
async function fixture(filtered=false){const t=await nativeLinearFixture(0,()=>true,filtered,undefined,false,true,true),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});t.kinematics.markHomed([0,1,2]);g.enable();return {t,g,async close(){await g.close();await t.close();}};}
async function maintenance(t:Awaited<ReturnType<typeof nativeLinearFixture>>){const end=performance.now()+8000;while(!t.port.status.pausedClockMaintenance){if(t.port.status.failed)throw t.port.status.fault;assert(performance.now()<end,'paused maintenance did not start');await delay(5);}}
for(const filtered of [false,true])test(`held G-code pause calibrates without changing retained motion and parking joins maintenance (filtered=${filtered})`,async()=>{
 const f=await fixture(filtered),{t,g}=f;let running:Promise<void>|undefined;try{
  let finished=false;running=g.dispatch.execute('G1 X51 E2.02 F60').then(()=>{finished=true;});void running.catch(()=>{});await nativeStreamStarted(t);
  const stopped=await t.port.pauseStream(signal()),p=[...stopped.position],modal=structuredClone(g.coordinates.state),clock=t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline,segments=clock.status.segments;
  await maintenance(t);const parked=[p[0],p[1],p[2]+.1,p[3]],trace=t.f.fw.motion.filter(m=>m.name==='queue_step').length;
  t.port.validatePausedPath([{position:parked,speed:5},{position:p,speed:5}]);
  const parking=t.port.movePaused(parked,5,signal());assert.equal(t.port.status.pausedMotion,true);assert.equal(finished,false);assert.deepEqual(t.port.status.pausePosition,p);assert.deepEqual(g.coordinates.state,modal);
  await parking;assert(clock.status.segments>segments);assert(t.f.fw.motion.filter(m=>m.name==='queue_step').length>trace);assert.equal(finished,false);
  await t.port.movePaused(p,5,signal());await t.port.resumeStream(signal());await running;
  assert.deepEqual(t.generation.motion.bindings.map(b=>b.history.status.lastPlannedPosition),[200n,22n,0n,0n]);assert.deepEqual(g.coordinates.state.position,[51,0,0,2.02]);assert.equal(t.f.stops,0);
 }finally{await f.close();await running?.catch(()=>{});}
});
test('stationary pause resume and heater boundary await active clock maintenance',async()=>{
 const f=await fixture(),{t,g}=f;try{
  await t.port.pause(signal());await maintenance(t);let boundary=false,resumed=false;
  const heat=t.port.heaterBoundary(signal()).then(()=>{boundary=true;}),resume=t.port.resumeStream(signal()).then(()=>{resumed=true;});
  await delay(5);assert.equal(boundary,false);assert.equal(resumed,false);await heat;await resume;assert.equal(t.port.status.pausedClockMaintenance,false);
  await g.dispatch.execute('G1 X51 F600');assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(t.f.stops,0);
 }finally{await f.close();}
});
test('cancelling a resume waiting for calibration stops the held stream and every MCU',async()=>{
 const f=await fixture(),{t,g}=f,cancel=new AbortController();let running:Promise<void>|undefined;try{
  running=g.dispatch.execute('G1 X51 F60');const stopped=assert.rejects(running);await nativeStreamStarted(t);await t.port.pauseStream(signal());await maintenance(t);
  const resume=t.port.resumeStream(cancel.signal),failed=assert.rejects(resume);cancel.abort(new Error('cancel calibrated resume'));await failed;await stopped;
  assert.equal(t.port.status.pausedClockMaintenance,false);assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,2);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await f.close();await running?.catch(()=>{});}
});
test('closing a stationary paused owner retires calibration before native disposal',async()=>{
 const f=await fixture(),{t,g}=f;try{
  await t.port.pause(signal());await maintenance(t);await g.close();assert.equal(t.port.status.pausedClockMaintenance,false);assert.equal(t.port.status.busy,false);assert.equal(t.f.stops,2);
  assert.throws(()=>t.port.maintainPausedClocks(signal()),/stopped/);
 }finally{await f.close();}
});
test('product resume keeps paused calibration active while waiting for heaters to recover',async()=>{
 const script=Array.from({length:256},(_,i)=>`G1 X${50+(i+1)/256} F30`).join('\n')+'\n';
 const f=await nativePrintFixture(script,false,false,true),owner=await createNativeLinearPrint(f.options),eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());
 try{
  await owner.device.prepare({version:1,requestId:'paused-heat',fileId:'file',nozzle:210,bed:60},signal());await owner.device.start('file',signal());await nativeStreamStarted(f.t);await owner.device.pause(signal());
  f.runtimes[0].sample(2,190);f.runtimes[1].sample(2,40);const clock=f.t.generation.clockTimelines!.find(c=>c.id==='m')!.timeline,before=clock.status.segments,parked=f.t.generation.source.status.position;let resumed=false;
  const resume=owner.device.resume(signal()).then(()=>{resumed=true;});void resume.catch(()=>{});const end=performance.now()+8000;
  while(clock.status.segments<=before||f.t.port.status.pausedClockMaintenance){if(f.t.port.status.failed)throw f.t.port.status.fault;assert(performance.now()<end);await delay(10);}
  assert.equal(resumed,false);assert.deepEqual(f.t.generation.source.status.position,parked);f.runtimes[0].sample(3,220);f.runtimes[1].sample(3,80);
  await resume;await eof.promise;await owner.device.finish('paused-heat',signal());assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);assert.equal(f.t.f.stops,0);
 }finally{await owner.close();await f.close();}
});
