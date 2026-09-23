import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeLinearHomingPort} from '../src/homing/native-linear-port.ts';
import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {LinearKinematics} from '../src/kinematics/linear.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {ExtrusionGuard} from '../src/motion/extrusion.ts';
import {motionLimits} from '../src/motion/lookahead.ts';
import {bindRebuiltMotion} from '../src/runtime/rebuilt-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {rebuiltFixture} from './helpers/rebuilt-motion.ts';
const signal=()=>new AbortController().signal;
async function fixture(retractDistance=0){
 const f=await rebuiltFixture(false,true);
 try{
  const generation=await bindRebuiltMotion(f.options),kinematics=new LinearKinematics({kind:'cartesian',ranges:[[0,52],[0,200],[0,200]],maxVelocity:100,maxAccel:1000,maxZVelocity:5,maxZAccel:100});
  const groups=[{members:[{physicalMember:0,trigger:f.options.members[0].trigger,emitters:f.emitters.map(e=>e.id)}],primary:0,endstop:f.endstop,expireTimeout:.25}];
  const port=new NativeLinearHomingPort({generation,kinematics,emitters:f.emitters,kinematicIds:['x','y','z'],groupsByAxis:[groups,groups,groups],limits:motionLimits(100,1000),extrusion:new ExtrusionGuard({nozzleDiameter:.4,filamentDiameter:1.75,maxCrossSection:1,maxVelocity:30,maxAccel:100,maxDistance:50,instantCornerVelocity:1}),canExtrude:()=>false});
  const coordinates=new GCodeMove(port),rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance,retractSpeed:10,secondSpeed:5,endstops:['test']}));
  const command=new LinearHomingCommand(kinematics,coordinates,port,rails,5000);
  return {f,port,kinematics,coordinates,command,async close(){await port.dispose();await f.close();}};
 }catch(error){await f.close();throw error;}
}
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
