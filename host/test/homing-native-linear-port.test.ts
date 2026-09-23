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
