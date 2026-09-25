import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {mkdtemp,writeFile,open,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {bindNativeFileMotion} from '../src/operations/native-file-motion.ts';
import {FilePrintDevice} from '../src/operations/file-print-device.ts';
import {GCodeFileReader} from '../src/gcode/file-reader.ts';
const rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
test('native pressure command owns its binding and preserves exact final motion through window changes',async()=>{
 const t=await nativeLinearFixture(0,()=>true,true),reports:string[]=[],binding={stepper:'e',name:'extruder'};
 const g=new NativeLinearGCode(t.port,t.kinematics,rails,m=>reports.push(m),5000,1,undefined,binding);
 try{
  binding.stepper='wrong';binding.name='wrong';t.kinematics.markHomed([0]);g.enable();
  await g.dispatch.execute('SET_PRESSURE_ADVANCE EXTRUDER=extruder ADVANCE=0.1\nG1 X51 E2.1 F600\nSET_PRESSURE_ADVANCE ADVANCE=0.2 SMOOTH_TIME=0.08\nG1 X52 E2.2\nSET_PRESSURE_ADVANCE ADVANCE=0');
  assert.deepEqual(g.pressureAdvance!.pressureAdvance,{advance:0,smoothTime:.08});
  assert.equal(g.pressureAdvance!.name,'extruder');assert.equal(reports.filter(r=>r.includes('pressure_advance:')).length,3);
  assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,300n);
  assert.equal(t.generation.motion.bindings.find(b=>b.id==='e')!.history.status.lastPlannedPosition,40n);
  assert.equal(t.port.status.failed,false);
 }finally{await g.close();await t.close();}
});
test('invalid pressure binding does not consume native dispatch ownership',async()=>{
 const t=await nativeLinearFixture(0,()=>true,true);let g:NativeLinearGCode|undefined;
 try{
  assert.throws(()=>new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,{stepper:'missing',name:'extruder'}));
  assert.throws(()=>new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,{stepper:'e',name:''}));
  g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000,1,undefined,{stepper:'e',name:'extruder'});g.enable();
  await assert.rejects(g.dispatch.execute('SET_PRESSURE_ADVANCE EXTRUDER=wrong ADVANCE=0.2\nG1 X51'),/Unknown pressure advance extruder/);
  assert.deepEqual(g.pressureAdvance!.pressureAdvance,{advance:.05,smoothTime:.04});assert.equal(t.f.fw.motion.length,0);
 }finally{await g?.close();await t.close();}
});
test('native G-code assembly owns G28 and modal motion through exact step output',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{},5000);let sent=false;
 const timer=setInterval(()=>{
  const arm=t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||sent)return;
  const clock=BigInt(Number(arm.parameters.clock));if(t.f.options.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;sent=true;
  t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{
  await assert.rejects(g.dispatch.execute('G28 X'),/not ready/);assert.equal(t.f.fw.motion.length,0);
  assert.throws(()=>new NativeLinearGCode(t.port,t.kinematics,rails,()=>{}),/ownership/);
  g.enable();assert.equal(t.kinematics.status.homedAxes,'');await g.dispatch.execute('G28 X');assert(sent);assert.equal(t.kinematics.status.homedAxes,'x');
  const before=t.f.fw.motion.length;await g.dispatch.execute('G91\nG1 X0.5 F600\nG90\nM400');
  assert.deepEqual(g.coordinates.state.position,[51.5,0,0,2]);assert.deepEqual(t.port.position(),[51.5,0,0,2]);
  assert.equal(t.f.fw.motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),50);assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await g.close();await t.close();}
});
for(const command of ['START_PRINT','M104 S200','M105','M21'])test(`native G-code rejects missing ${command} before admitting its suffix`,async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});
 try{
  t.kinematics.markHomed([0]);g.enable();await assert.rejects(g.dispatch.execute(`${command}\nG1 X51 F600`,{acknowledge:true}),/Unsupported command/);
  assert.equal(t.port.status.failed,true);assert.equal(t.f.fw.motion.length,0);assert.deepEqual(g.coordinates.state.position,[50,0,0,2]);assert.throws(()=>g.enable(),/closed/);
 }finally{await g.close();await t.close();}
});
test('native stop aborts an active non-motion handler and fences the queued script',async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{}),entered=Promise.withResolvers<void>();
 try{
  g.dispatch.register('WAIT',c=>new Promise<void>((resolve,reject)=>{c.signal.addEventListener('abort',()=>reject(c.signal.reason),{once:true});entered.resolve();}));g.enable();
  const pending=g.dispatch.execute('WAIT'),rejected=assert.rejects(pending,/Native motion stopped/),queued=g.dispatch.execute('G1 X51'),fenced=assert.rejects(queued,/invalidated/);
  await entered.promise;await t.generation.group.stop(new Error('MCU lost'));await rejected;await fenced;assert.equal(t.f.fw.motion.length,0);
 }finally{await g.close();await t.close();}
});
for(const unsupported of [false,true])test(`assembled file owner ${unsupported?'fails on an unsupported command without replay':'streams modal moves and drains before output completion'}`,async()=>{
 const t=await nativeLinearFixture(),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{}),dir=await mkdtemp(join(tmpdir(),'native-gcode-')),path=join(dir,'print.gcode');let finished=0,stops=0;
 const motion=bindNativeFileMotion(t.port,{parkXY:[50,0],retract:0,lift:0,travelSpeed:10,liftSpeed:5,retractSpeed:5},{prepare:async()=>g.enable(),start:async()=>{},finishOutputs:async()=>{assert.equal(t.port.status.pendingMoves,0);assert.equal(t.generation.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,200n);finished++;},stopOutputs:async()=>{stops++;}});
 const device=new FilePrintDevice(motion,g.dispatch,async()=>GCodeFileReader.adopt(await open(path,'r'))),done=Promise.withResolvers<void>();
 device.subscribeEOF(()=>done.resolve());device.subscribeFault(()=>done.resolve());
 try{
  t.kinematics.markHomed([0]);await writeFile(path,unsupported?'M104 S200\nG1 X51 F600\n':'SET_PRINT_STATS_INFO TOTAL_LAYER=100\nG91\n'+Array.from({length:256},()=> 'G1 X0.00390625 F60\n').join('')+'G90\nSET_PRINT_STATS_INFO CURRENT_LAYER=99\n');
  const signal=new AbortController().signal;await device.prepare({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0},signal);await device.start('file',signal);await done.promise;
  if(unsupported){await device.stop();assert(device.status.fault);assert.equal(device.status.file?.closed,true);assert.equal(t.f.fw.motion.length,0);assert.equal(finished,0);assert.equal(stops,1);}
  else{assert.deepEqual(g.layers.status,{total_layer:100,current_layer:99});assert.equal(device.status.file?.phase,'eof');await device.finish('job',signal);assert.equal(finished,1);assert.equal(stops,0);assert.deepEqual(g.coordinates.state.position,[51,0,0,2]);assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===3).reduce((sum,m)=>sum+Number(m.parameters.count),0),100);}
 }finally{await device.stop();await g.close();await t.close();await rm(dir,{recursive:true,force:true});}
});
