import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture as fixture,nativeStreamStarted as streamStarted} from './helpers/native-linear-port.ts';
const signal=()=>new AbortController().signal;
for(const filtered of [false,true])test(`paused native travel returns exactly before the original print suffix resumes (filtered=${filtered})`,async()=>{
 const t=await fixture(0,()=>true,filtered);try{
  t.kinematics.markHomed([0,1,2]);t.coordinates.execute('G1',{X:'51',E:'2.02',F:'30'});let finished=false;const running=t.port.drain(signal()).then(()=>{finished=true;});await streamStarted(t);
  const stop=await t.port.pauseStream(signal()),p=[...stop.position],modal=structuredClone(t.coordinates.state);
  await t.port.movePaused([p[0],p[1],p[2]+.2,p[3]-.01],5,signal());
  const parked=[51.5,.2,p[2]+.2,p[3]-.01],parking=t.port.movePaused(parked,10,signal());
  await assert.rejects(t.port.resumeStream(signal()),/Paused motion is busy/);await assert.rejects(t.port.movePaused(p,10,signal()),/busy/);await parking;
  assert.equal(finished,false);assert.deepEqual(t.generation.source.status.position,parked);assert.deepEqual(t.port.position(),[51,0,0,2.02]);assert.deepEqual(t.coordinates.state,modal);assert.deepEqual(t.port.status.pausePosition,p);
  await assert.rejects(t.port.resumeStream(signal()),/return to the drained pause position/);assert.equal(t.f.stops,0);
  await t.port.movePaused([p[0],p[1],p[2]+.2,p[3]-.01],10,signal());await t.port.movePaused(p,5,signal());
  assert.deepEqual(t.generation.source.status.position,p);await t.port.resumeStream(signal());await running;
  const positions=new Map(t.generation.motion.bindings.map(b=>[b.id,b.history.status.lastPlannedPosition]));assert.deepEqual(positions,new Map([['x',200n],['e',22n],['y',0n],['z',0n]]));assert.equal(t.f.stops,0);assert.equal(t.port.status.pausePosition,undefined);
 }finally{await t.close();}
});
for(const dispose of [false,true])test(`paused travel ${dispose?'disposal waits both motion owners':'cancellation aborts both motion owners'}`,async()=>{
 const t=await fixture(),cancel=new AbortController();try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],.5);const running=t.port.drain(signal()),failed=assert.rejects(running);await streamStarted(t);await t.port.pauseStream(signal());
  const parking=t.port.movePaused([51.5,0,0,2],.1,cancel.signal),rejected=assert.rejects(parking);assert.equal(t.port.status.pausedMotion,true);
  if(dispose)await t.port.dispose();else cancel.abort(new Error('cancel parking'));
  await rejected;await failed;assert.equal(t.port.status.pausedMotion,false);assert.equal(t.port.status.busy,false);assert.equal(t.f.stops,1);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
for(const prior of ['unused','drained','pending'] as const)test(`product pause owns ${prior} boundary motion and releases it before new admission`,async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0,1,2]);
  if(prior!=='unused')t.port.move([51,0,0,2],.5);if(prior==='drained')await t.port.drain(signal());
  const pending=t.port.pause(signal());assert.equal(pending,t.port.pause(signal()));const stopped=await pending;
  assert.equal(t.port.status.pauseMode,prior==='pending'?'owned':'stationary');assert.equal(t.generation.source.status.paused,true);
  if(prior==='pending')assert(stopped.position[0]>50&&stopped.position[0]<51);
  assert.throws(()=>t.port.move([51.5,0,0,2],1),/paused|busy/);await assert.rejects(t.port.forcePosition(stopped.position,signal()),/paused|busy/);await assert.rejects(t.port.drain(signal()),/paused|busy/);
  await t.port.movePaused([51.5,.2,.2,2],10,signal());await t.port.movePaused(stopped.position,10,signal());await t.port.resumeStream(signal());
  assert.equal(t.port.status.busy,prior==='pending');assert.equal(t.port.status.pauseMode,undefined);t.port.move([51.75,0,0,2],10);await t.port.drain(signal());assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,275n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('owned boundary resume returns promptly and waiting checkpoints remain cancellable',async()=>{
 const t=await fixture(),cancel=new AbortController();try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],.1);await t.port.pause(signal());
  const before=performance.now();await t.port.resumeStream(signal());assert(performance.now()-before<500);assert.equal(t.port.status.busy,true);
  t.port.move([51.5,0,0,2],1);const draining=t.port.drain(cancel.signal),failed=assert.rejects(draining,/cancel owned checkpoint|stopped/);cancel.abort(new Error('cancel owned checkpoint'));await failed;assert.equal(t.f.stops,1);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
test('file motion binding parks at a command boundary and resumes admission behind its owned suffix',async()=>{
 const t=await fixture(),{mkdtemp,open,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'native-boundary-file-')),entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();let device:import('../src/operations/file-print-device.ts').FilePrintDevice|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);const {GCodeDispatch}=await import('../src/gcode/dispatch.ts'),{GCodeFileReader}=await import('../src/gcode/file-reader.ts'),{FilePrintDevice}=await import('../src/operations/file-print-device.ts'),{bindNativeFileMotion}=await import('../src/operations/native-file-motion.ts');let admitted=0,outputs=0;
  const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{void t.port.motorOff(new Error(reason));},checkpoint:s=>t.port.flush(s),drain:s=>t.port.drain(s)});
  dispatch.register('G1',async c=>{t.coordinates.execute('G1',c.params);if(++admitted===1){entered.resolve();await gate.promise;}});
  const path=join(dir,'test.gcode');await writeFile(path,'G1 X50.5 F12\nG1 X51 F12\n');
  const motion=bindNativeFileMotion(t.port,{parkXY:[51.5,.2],retract:0,lift:.2,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:async()=>dispatch.setReady(true),start:async()=>{},finishOutputs:async()=>{assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);outputs++;},stopOutputs:async()=>{}});
  device=new FilePrintDevice(motion,dispatch,async()=>GCodeFileReader.adopt(await open(path,'r')));const eof=Promise.withResolvers<void>();device.subscribeEOF(()=>eof.resolve());await device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal());await device.start('file',signal());await entered.promise;
  const pausing=device.pause(signal());gate.resolve();await pausing;assert.equal(admitted,1);assert.equal(device.status.file?.checkpointHeld,false);assert.equal(device.status.file?.position,0);assert.equal(t.port.status.pauseMode,'owned');assert.equal(outputs,0);
  await device.resume(signal());await eof.promise;await device.finish('job',signal());assert.equal(admitted,2);assert.equal(outputs,1);assert.deepEqual(t.coordinates.state.position,[51,0,0,2]);assert.equal(t.f.stops,0);
 }finally{gate.resolve();await device?.stop();await t.close();await rm(dir,{recursive:true,force:true});}
});
test('a second pause during boundary handoff retains newly admitted tail exactly once',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],.5);await t.port.pause(signal());await t.port.resumeStream(signal());
  t.port.move([51.5,0,0,2],1);let completed=false;const checkpoint=t.port.flush(signal()).then(()=>{completed=true;});const paused=await t.port.pause(signal());
  assert.equal(completed,false);assert.equal(t.port.status.pendingMoves,0);assert(paused.position[0]<51.5);await t.port.resumeStream(signal());await checkpoint;await t.port.drain(signal());assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,250n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('immediate filtered boundary pause can brake before the first ordinary generation window',async()=>{
 const t=await fixture(0,()=>true,true);try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.02],10);const stopped=await t.port.pause(signal());assert(stopped.position[0]>50&&stopped.position[0]<51);
  await t.port.resumeStream(signal());await t.port.drain(signal());assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);assert.equal(t.generation.motion.bindings.find(b=>b.id==='e')!.history.status.lastPlannedPosition,22n);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
