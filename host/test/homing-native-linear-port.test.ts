import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture as fixture,nativeStreamStarted as streamStarted} from './helpers/native-linear-port.ts';
const signal=()=>new AbortController().signal;
import {serialClock} from '../src/protocol/serial-queue.ts';
test('real G28 port rebases, seeks, grants homing and drains subsequent guarded motion',async()=>{
 const t=await fixture();let sent=false;
 const timer=setInterval(()=>{
  const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);
  if(!arm||sent)return;
  const clock=BigInt(Number(arm.parameters.clock)),now=t.f.options.members[0].session.clock.sync.getClock(serialClock.now());
  if(now<clock)return;sent=true;
  t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);
  t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{
  assert.throws(()=>t.port.move([51,0,0,2],10),/home/i);
  await t.command.home([0],signal());assert(sent);assert.equal(t.kinematics.status.homedAxes,'x');assert.deepEqual(t.port.position(),[51,0,0,2]);assert.deepEqual(t.coordinates.state.position,[51,0,0,2]);
  assert.throws(()=>t.port.move([51,0,0,3],10),/temperature/);
  const before=t.f.fw.motion.length;t.port.move([51.5,0,0,2],10);await t.port.drain(signal());assert.equal(t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),50);assert.deepEqual(t.port.position(),[51.5,0,0,2]);assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await t.close();}
});
test('missing G28 trigger fences the native port and revokes homing authority',async()=>{
 const t=await fixture();try{await assert.rejects(t.command.home([0],signal()),/No trigger/);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);assert.throws(()=>t.port.move([51,0,0,2],10),/stopped/);}finally{await t.close();}
});
test('cancellation during native G28 cannot publish a healthy late generation',async()=>{
 const t=await fixture(),a=new AbortController();const timer=setTimeout(()=>a.abort(new Error('cancel native G28')),25);
 try{await assert.rejects(t.command.home([0],a.signal),/cancel native G28/);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);assert.throws(()=>t.port.assertActive(),/stopped/);}finally{clearTimeout(timer);await t.close();}
});
for(const stuck of [false,true])test(`two-pass native G28 ${stuck?'rejects an immediate second trigger':'ignores idle E/Y/Z and completes'}`,async()=>{
 const t=await fixture(.2);let hits=0;
 const timer=setInterval(()=>{
  // The firmware replacement does not integrate pulses; install explicit
  // counters at each phase and emulate the fresh host stop reason.
  if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);if(t.port.status.phase==='retract')t.f.fw.setStepperPosition(3,120);return;}
  const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);
  if(arms.length<=hits)return;
  const arm=arms[hits],clock=BigInt(Number(arm.parameters.clock))+(hits&&!stuck?30000n:0n);
  if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;
  if(hits)t.f.fw.setStepperPosition(3,stuck?120:107);
  hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{if(stuck){await assert.rejects(t.command.home([0],signal()),/still triggered/);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.f.stops,1);}else{await t.command.home([0],signal());assert.equal(t.kinematics.status.homedAxes,'x');assert(Math.abs(t.port.position()[0]-51)<1e-12);assert.equal(t.f.stops,0);}assert.equal(hits,2);}finally{clearInterval(timer);await t.close();}
});
test('G-code checkpoints stream native motion and reserve final drain for script completion',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0]);const {GCodeDispatch}=await import('../src/gcode/dispatch.ts');let checkpoints=0,drains=0,streamed=false;
  const d=new GCodeDispatch({output(){},shutdown(reason){void t.port.motorOff(new Error(reason));},async checkpoint(s){await t.port.flush(s);checkpoints++;streamed ||= t.f.fw.motion.some(m=>m.name==='queue_step');},async drain(){drains++;await t.port.drain(signal());}});
  d.register('G1',c=>t.coordinates.execute('G1',c.params));d.setReady(true);
  await d.execute(Array.from({length:512},(_,i)=>`G1 X${50+(i+1)/512} F60`).join('\n'));
  assert(checkpoints>=3);assert(streamed);assert.equal(drains,1);assert.deepEqual(t.port.position(),[51,0,0,2]);assert.equal(t.f.stops,0);
  assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);
 }finally{await t.close();}
});
test('file batches preserve streaming lookahead until the print owner requests final drain',async()=>{
 const t=await fixture(),{mkdtemp,open,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'native-file-stream-'));
 try{
  t.kinematics.markHomed([0]);const {GCodeDispatch}=await import('../src/gcode/dispatch.ts'),{GCodeFileReader}=await import('../src/gcode/file-reader.ts'),{GCodeFileExecution}=await import('../src/gcode/file-execution.ts');let checkpoints=0,drains=0;
  const d=new GCodeDispatch({output(){},shutdown(reason){void t.port.motorOff(new Error(reason));},async checkpoint(s){await t.port.flush(s);checkpoints++;},async drain(s){drains++;await t.port.drain(s);}});d.register('G1',c=>t.coordinates.execute('G1',c.params));d.setReady(true);
  const path=join(dir,'test.gcode');await writeFile(path,Array.from({length:512},(_,i)=>`G1 X${50+(i+1)/512} F60\n`).join(''));const execution=new GCodeFileExecution(await GCodeFileReader.adopt(await open(path,'r')),d);
  await execution.start();assert.equal(execution.status.phase,'eof');assert.equal(drains,0);assert(checkpoints>=4);assert(t.port.status.pendingMoves>0);assert(t.f.fw.motion.some(m=>m.name==='queue_step'));
  await t.port.drain(signal());assert.equal(t.port.status.pendingMoves,0);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);assert.equal(t.f.stops,0);
 }finally{await t.close();await rm(dir,{recursive:true,force:true});}
});
test('a partial file pause drains only admitted native steps and resumes the suffix without replay',async()=>{
 const t=await fixture(),{mkdtemp,open,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'native-file-pause-'));
 const entered=Promise.withResolvers<void>(),gate=Promise.withResolvers<void>();let execution:import('../src/gcode/file-execution.ts').GCodeFileExecution|undefined;
 try{
  t.kinematics.markHomed([0]);const {GCodeDispatch}=await import('../src/gcode/dispatch.ts'),{GCodeFileReader}=await import('../src/gcode/file-reader.ts'),{GCodeFileExecution}=await import('../src/gcode/file-execution.ts');let admitted=0;
  const d=new GCodeDispatch({output(){},shutdown(reason){void t.port.motorOff(new Error(reason));},checkpoint:s=>t.port.flush(s),drain:s=>t.port.drain(s)});
  d.register('G1',async c=>{t.coordinates.execute('G1',c.params);if(++admitted===1){entered.resolve();await gate.promise;}});d.setReady(true);
  const path=join(dir,'test.gcode');await writeFile(path,'G1 X50.5 F60\nG1 X51 F60\n');execution=new GCodeFileExecution(await GCodeFileReader.adopt(await open(path,'r')),d);
  const done=execution.start();await entered.promise;const paused=execution.pause();gate.resolve();await paused;await t.port.drain(signal());
  const steps=()=>t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0);
  assert.equal(admitted,1);assert.equal(steps(),50);assert.equal(execution.status.position,0);assert.deepEqual(t.port.position(),[50.5,0,0,2]);
  await d.execute('M110');execution.resume();await done;await t.port.drain(signal());assert.equal(admitted,2);assert.equal(steps(),100);assert.deepEqual(t.port.position(),[51,0,0,2]);assert.equal(t.f.stops,0);
 }finally{gate.resolve();await execution?.stop();await t.close();await rm(dir,{recursive:true,force:true});}
});
for(const lazy of [false,true])test(`native port transfers its closing tail and acknowledges guarded resume (lazy=${lazy})`,async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0]);for(let i=1;i<=40;i++)t.port.move([50+i/40,0,0,2],.5);
  let completed=false;const running=(lazy?t.port.flush(signal()):t.port.drain(signal())).then(()=>{completed=true;});await streamStarted(t);
  const paused=t.port.pauseStream(signal());assert.equal(paused,t.port.pauseStream(signal()));const stop=await paused;
  assert(stop.position[0]>50&&stop.position[0]<51);assert.equal(t.port.status.pendingMoves,0);assert.equal(completed,false);assert.deepEqual(t.port.position(),[51,0,0,2]);
  assert.throws(()=>t.port.move([51.5,0,0,2],1),/busy/);await assert.rejects(t.port.forcePosition([51,0,0,2],signal()),/busy/);
  const packets=t.f.fw.motion.length;await new Promise(r=>setTimeout(r,100));assert.equal(t.f.fw.motion.length,packets);
  await t.port.resumeStream(signal());assert.equal(completed,false);await running;await t.port.drain(signal());
  assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((n,m)=>n+Number(m.parameters.count),0),100);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('native resume rejects a cooled extruder and cannot publish any retained suffix',async()=>{
 let hot=true;const t=await fixture(0,()=>hot);try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.02],.5);const running=t.port.drain(signal()),rejected=assert.rejects(running,/temperature|stopped/);
  await streamStarted(t);await t.port.pauseStream(signal());const packets=t.f.fw.motion.length;hot=false;
  await assert.rejects(t.port.resumeStream(signal()),/temperature/);await rejected;assert.equal(t.f.fw.motion.length,packets);assert.equal(t.f.stops,1);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
test('native pause cancellation stops the held stream and revokes homing',async()=>{
 const t=await fixture(),cancel=new AbortController();try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],.5);const running=t.port.drain(signal()),rejected=assert.rejects(running,/cancel native pause|stopped|ready/);await streamStarted(t);
  const pause=t.port.pauseStream(cancel.signal),failed=assert.rejects(pause,/cancel native pause|stopped|ready/);cancel.abort(new Error('cancel native pause'));await failed;await rejected;
  assert.equal(t.f.stops,1);assert.equal(t.kinematics.status.homedAxes,'');
 }finally{await t.close();}
});
for(const park of [false,true])test(`file device pauses and resumes active native checkpoints (parking=${park})`,async()=>{
 const t=await fixture(),{mkdtemp,open,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path');const dir=await mkdtemp(join(tmpdir(),'native-product-pause-'));
 let device:import('../src/operations/file-print-device.ts').FilePrintDevice|undefined;
 try{
  t.kinematics.markHomed([0,1,2]);const {GCodeDispatch}=await import('../src/gcode/dispatch.ts'),{GCodeFileReader}=await import('../src/gcode/file-reader.ts'),{FilePrintDevice}=await import('../src/operations/file-print-device.ts');const seen:string[]=[];let held=false,ordinary=0;
  const dispatch=new GCodeDispatch({output(){},shutdown:reason=>{void t.port.motorOff(new Error(reason));},checkpoint:s=>t.port.flush(s),drain:s=>t.port.drain(s)});
  dispatch.register('G1',c=>{seen.push(c.params.X);t.coordinates.execute('G1',c.params);});
  const {bindNativeFileMotion}=await import('../src/operations/native-file-motion.ts');
  const path=join(dir,'test.gcode');await writeFile(path,Array.from({length:512},(_,i)=>`G1 X${50+(i+1)/512} F12\n`).join(''));
  const direct={prepare:async()=>dispatch.setReady(true),start:async()=>{},pause:async (s:AbortSignal)=>{ordinary++;await t.port.drain(s);},pauseCheckpoint:async (s:AbortSignal)=>{await t.port.pauseStream(s);held=true;},resume:async (s:AbortSignal)=>{if(held){await t.port.resumeStream(s);held=false;}},finish:async(_id:string,s:AbortSignal)=>t.port.drain(s),stop:()=>t.port.motorOff(new Error('file device stopped'))};
  const motion=park?bindNativeFileMotion(t.port,{parkXY:[51.5,.2],retract:0,lift:.2,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:direct.prepare,start:direct.start,finishOutputs:async()=>{},stopOutputs:async()=>{}}):direct;
  device=new FilePrintDevice(motion,dispatch,async()=>GCodeFileReader.adopt(await open(path,'r')));
  const eof=Promise.withResolvers<void>();device.subscribeEOF(()=>eof.resolve());await device.prepare({version:1,requestId:'test',fileId:'file',nozzle:200,bed:60},signal());await device.start('file',signal());await streamStarted(t);
  const start=performance.now();await device.pause(signal());assert(performance.now()-start<(park?3000:1800));assert.equal(device.status.file?.phase,'paused');assert.equal(device.status.file?.checkpointHeld,true);assert.equal(ordinary,0);assert.equal(device.status.file?.position,0);assert(seen.length>0&&seen.length<512);
  const count=seen.length,packets=t.f.fw.motion.length;await new Promise(r=>setTimeout(r,100));assert.equal(seen.length,count);assert.equal(t.f.fw.motion.length,packets);
  await device.resume(signal());await eof.promise;await device.finish('test',signal());assert.equal(seen.length,512);assert.equal(new Set(seen).size,512);assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);assert.equal(t.generation.motion.bindings.find(b=>b.id==='y')!.history.status.lastPlannedPosition,0n);assert.equal(t.generation.motion.bindings.find(b=>b.id==='z')!.history.status.lastPlannedPosition,0n);assert.equal(t.f.stops,0);
 }finally{await device?.stop();await t.close();await rm(dir,{recursive:true,force:true});}
});

test('native window transaction publishes accepted parameters and continues paced extrusion',async()=>{
 const t=await fixture(0,()=>true,true);try{
  t.kinematics.markHomed([0]);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});
  t.port.move([51,0,0,2.1],10);const change={stepper:'e',advance:.1,smoothTime:.2};const pending=t.port.reconfigurePressureWindows([change],signal());change.smoothTime=.3;
  assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});assert.equal(t.port.status.phase,'pressure-window');assert.throws(()=>t.port.move([52,0,0,2.2],10),/busy/);await pending;
  assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.1,smoothTime:.2});assert(Object.isFrozen(t.port.pressureAdvanceSettings('e')));assert.equal(t.generation.source.status.paused,false);assert.equal(t.port.status.pendingMoves,0);
  t.port.move([52,0,0,2.2],10);await t.port.flush(signal());await t.port.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.02}],signal());t.port.move([51.5,0,0,2.3],10);await t.port.drain(signal());
  assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.1,smoothTime:.02});assert.deepEqual(t.port.position(),[51.5,0,0,2.3]);assert.equal(t.generation.motion.bindings[1]!.stepper.scanWindow.future,.01);
  await t.port.reconfigurePressureWindows([{stepper:'e',advance:0,smoothTime:.04}],signal());assert.equal(t.port.pressureAdvanceSettings('e').advance,0);await t.port.reconfigurePressureWindows([{stepper:'e',advance:.05,smoothTime:.04}],signal());assert.equal(t.generation.motion.bindings[1]!.stepper.scanWindow.future,.02);
  for(let i=0;i<3;i++){await t.port.reconfigurePressureWindows([{stepper:'e',advance:.05,smoothTime:.2}],signal());await t.port.reconfigurePressureWindows([{stepper:'e',advance:.05,smoothTime:.02}],signal());}
  t.port.move([51.75,0,0,2.3],10);await t.port.drain(signal());assert.equal(t.port.status.failed,false);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('window command rejects unknown and fixed-window changes without flushing pending motion',async()=>{
 const t=await fixture(0,()=>true,true);try{t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],10);const count=t.port.status.pendingMoves;
  assert.throws(()=>t.port.reconfigurePressureWindows([{stepper:'missing',advance:.1,smoothTime:.2}],signal()),/Unknown/);assert.throws(()=>t.port.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.04}],signal()),/endpoint admission/);
  assert.equal(t.port.status.pendingMoves,count);assert.equal(t.port.status.failed,false);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('window failure after native acceptance stops the port without publishing new parameters',async()=>{
 const t=await fixture(0,()=>true,true);try{const source=t.generation.source,original=source.reconfigurePressureWindows.bind(source),cause=new Error('failure after pressure window acceptance');
  source.reconfigurePressureWindows=async(...args)=>{await original(...args);throw cause;};
  await assert.rejects(t.port.reconfigurePressureWindows([{stepper:'e',advance:.1,smoothTime:.2}],signal()),e=>e===cause);
  assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
test('fixed-window pressure requests attach to pending geometry without flushing and publish owned settings',async()=>{
 const t=await fixture(0,()=>true,true);try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],10);const before=t.f.fw.motion.length,request={advance:.1,smoothTime:.04};
  const pending=t.port.setPressureAdvance('e',request,signal());request.advance=.4;await pending;
  for(let i=0;i<300;i++)await t.port.setPressureAdvance('e',{advance:i%2?.1:.08,smoothTime:.04},signal());
  assert.equal(t.port.status.pendingMoves,1);assert.equal(t.f.fw.motion.length,before);assert.equal(t.generation.source.status.seeded,false);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.1,smoothTime:.04});assert(Object.isFrozen(t.port.pressureAdvanceSettings('e')));
  assert.deepEqual(t.generation.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.05,smoothTime:.04}});
  t.port.move([52,0,0,2.2],10);await t.port.drain(signal());assert.deepEqual(t.generation.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.1,smoothTime:.04}});assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('pressure requests use idle, native tail and stationary window endpoints',async()=>{
 const t=await fixture(0,()=>true,true);try{
  t.kinematics.markHomed([0]);await t.port.setPressureAdvance('e',{advance:.08,smoothTime:.04},signal());await t.port.setPressureAdvance('e',{advance:.1,smoothTime:.04},signal());assert.equal(t.generation.source.status.pendingBoundaries,1);assert.equal(t.f.fw.motion.length,0);
  t.port.move([51,0,0,2.1],10);await t.port.dwell(.05,signal());assert(t.generation.source.status.bufferedMoves>0);const time=t.generation.source.status.sourceTime;
  await t.port.setPressureAdvance('e',{advance:.12,smoothTime:.04},signal());assert.equal(t.generation.source.status.sourceTime,time);await t.port.drain(signal());
  await t.port.setPressureAdvance('e',{advance:.15,smoothTime:.2},signal());assert.equal(t.generation.source.status.bufferedMoves,0);
  const stationary=t.generation.source.status.sourceTime;await t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal());assert.equal(t.generation.source.status.sourceTime,stationary);await t.port.drain(signal());
  assert.deepEqual(t.generation.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.2,smoothTime:.2}});assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('zero-window pressure intent is retained without motion and enables through the window barrier',async()=>{
 const t=await fixture(0,()=>true,true);try{
  await t.port.setPressureAdvance('e',{advance:.05,smoothTime:0},signal());const time=t.generation.source.status.sourceTime,count=t.f.fw.motion.length;
  await t.port.setPressureAdvance('e',{advance:.2,smoothTime:0},signal());assert.equal(t.generation.source.status.sourceTime,time);assert.equal(t.f.fw.motion.length,count);assert.equal(t.generation.motion.bindings[1].stepper.scanWindow.future,0);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.2,smoothTime:0});
  await t.port.setPressureAdvance('e',{advance:.2,smoothTime:.04},signal());assert.deepEqual(t.generation.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.2,smoothTime:.04}});
  await t.port.setPressureAdvance('e',{advance:0,smoothTime:.04},signal());const end=t.generation.source.status.sourceTime;await t.port.setPressureAdvance('e',{advance:0,smoothTime:.2},signal());assert.equal(t.generation.source.status.sourceTime,end);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:0,smoothTime:.2});assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('pressure prevalidation is harmless and a partial boundary failure stops without publishing new intent',async()=>{
 const t=await fixture(0,()=>true,true);try{
  assert.throws(()=>t.port.setPressureAdvance('missing',{advance:.1,smoothTime:.04},signal()),/Unknown/);assert.throws(()=>t.port.setPressureAdvance('e',{advance:NaN,smoothTime:.04},signal()));assert.equal(t.f.stops,0);
  const cause=new Error('pressure boundary publication failed'),mark=t.generation.source.markPressureBoundary.bind(t.generation.source);t.generation.source.markPressureBoundary=change=>{mark(change);throw cause;};
  await assert.rejects(t.port.setPressureAdvance('e',{advance:.1,smoothTime:.04},signal()),e=>e===cause);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
test('pressure requests respect active window, paused and cancelled ownership boundaries',async()=>{
 const t=await fixture(0,()=>true,true);try{
  const pending=t.port.setPressureAdvance('e',{advance:.1,smoothTime:.2},signal());await assert.rejects(t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal()),/busy/);await pending;assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.1,smoothTime:.2});assert.equal(t.f.stops,0);
  await t.port.pause(signal());const before=t.f.fw.motion.length;await t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal());assert.equal(t.f.fw.motion.length,before);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.2,smoothTime:.2});assert.equal(t.f.stops,0);await t.port.resumeStream(signal());
  const abort=new AbortController(),cause=new Error('cancel pressure request');abort.abort(cause);await assert.rejects(t.port.setPressureAdvance('e',{advance:.3,smoothTime:.2},abort.signal),e=>e===cause);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.2,smoothTime:.2});assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
test('paused tuning overrides retained pressure events and reuses stationary coverage across repeated windows',async()=>{
 const t=await fixture(0,()=>true,true,{minimumScheduleTime:.01,kickStartTime:0});try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],1);await t.port.setPressureAdvance('e',{advance:.1,smoothTime:.04},signal());t.port.move([52,0,0,2.2],1);await t.port.setPressureAdvance('e',{advance:.15,smoothTime:.04},signal());await t.port.queueCoolingFan(.5,signal());
  const running=t.port.drain(signal());void running.catch(()=>{});await streamStarted(t);await t.port.pauseStream(signal());const position=[...t.port.status.pausePosition!];
  await t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal());const time=t.generation.source.status.sourceTime,generated=t.generation.coordinator.status.generatedTime,packets=t.f.fw.motion.length;
  for(let i=0;i<30;i++)await t.port.setPressureAdvance('e',{advance:i%3? .3:0,smoothTime:i%2?.02:.2},signal());
  await t.port.setPressureAdvance('e',{advance:.25,smoothTime:.04},signal());assert.equal(t.generation.source.status.sourceTime,time);assert.equal(t.generation.coordinator.status.generatedTime,generated);assert.equal(t.f.fw.motion.length,packets);assert.equal(t.generation.source.status.paused,true);assert.deepEqual(t.port.status.pausePosition,position);
  await t.port.resumeStream(signal());await running;assert.deepEqual(t.port.position(),[52,0,0,2.2]);assert.deepEqual(t.generation.motion.bindings[1].stepper.recoveryFilters(),{pressureAdvance:{advance:.25,smoothTime:.04}});assert.equal(t.generation.motion.bindings[0].history.status.lastPlannedPosition,300n);assert.equal(t.generation.motion.bindings[1].history.status.lastPlannedPosition,40n);assert.equal(t.fan!.status.speed,.5);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('paused pressure refresh precedes asynchronous completion and fences resume until publication',async()=>{
 const t=await fixture(0,()=>true,true),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let pending:Promise<void>|undefined;
 try{
  t.kinematics.markHomed([0]);t.port.move([52,0,0,2.2],1);let finished=false;const running=t.port.drain(signal()).then(()=>{finished=true;});void running.catch(()=>{});await streamStarted(t);await t.port.pauseStream(signal());
  const apply=t.generation.drain.reconfigurePressureWindows.bind(t.generation.drain);t.generation.drain.reconfigurePressureWindows=(...args)=>{const after=args[5];args[5]=async(h,s)=>{await after?.(h,s);entered.resolve();await release.promise;};return apply(...args);};
  pending=t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal());void pending.catch(()=>{});await entered.promise;assert.equal(t.generation.motion.bindings[1].stepper.scanWindow.future,.1);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});
  await assert.rejects(t.port.resumeStream(signal()),/busy/);await assert.rejects(t.port.setPressureAdvance('e',{advance:.3,smoothTime:.2},signal()),/busy/);await new Promise(r=>setTimeout(r,150));assert.equal(finished,false);assert.equal(t.f.stops,0);
  release.resolve();await pending;assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.2,smoothTime:.2});await t.port.resumeStream(signal());await running;assert.equal(t.f.stops,0);
 }finally{release.resolve();await pending?.catch(()=>{});await t.close();}
});
test('failed paused pressure transaction stops while retaining prior public configuration',async()=>{
 const t=await fixture(0,()=>true,true);try{
  await t.port.pause(signal());const original=t.generation.source.reconfigurePausedPressureWindows.bind(t.generation.source),cause=new Error('paused pressure completion failed');t.generation.source.reconfigurePausedPressureWindows=async(...args)=>{await original(...args);throw cause;};
  await assert.rejects(t.port.setPressureAdvance('e',{advance:.2,smoothTime:.2},signal()),e=>e===cause);assert.deepEqual(t.port.pressureAdvanceSettings('e'),{advance:.05,smoothTime:.04});assert.equal(t.port.status.failed,true);assert.equal(t.f.stops,1);
 }finally{await t.close();}
});
