import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeCarriageFixture as fixture} from './helpers/native-carriage-port.ts';
const signal=()=>new AbortController().signal;
test('native port publishes primary only after exclusive rebase and applies second rail limits',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0,1,2]);const before=t.f.fw.motion.length;
  const pending=t.port.setCarriageMode(1,'PRIMARY',signal());assert.equal(t.port.status.phase,'carriage');assert.equal(t.port.carriageStatus!.primary,0);assert.throws(()=>t.port.move([51,0,0,2],10),/busy/);
  await pending;assert.equal(t.port.carriageStatus!.primary,1);assert.deepEqual(t.port.position(),[180,0,0,2]);assert.equal(t.f.fw.motion.length,before);
  assert.deepEqual(t.port.carriageStatus!.homed,[true,false]);assert.equal(t.kinematics.status.homedAxes,'yz');t.kinematics.markHomed([0]);
  t.port.move([180.1,0,0,2],10);await t.port.drain(signal());
  const steps=t.f.fw.motion.filter(m=>m.name==='queue_step');assert.equal(steps.filter(m=>m.parameters.oid===3).length,0);assert.equal(steps.filter(m=>m.parameters.oid===5).reduce((n,m)=>n+Number(m.parameters.count),0),10);
  assert.equal(t.kinematics.status.axisMaximum[0],220);assert.deepEqual(t.kinematics.calcPosition([180,0,0]),[180,0,0]);
  // The parked first carriage at 50 requires the active second to remain >=60.
  assert.throws(()=>t.port.move([59,0,0,2],10),/range/);
 }finally{await t.close();}
});
test('copy and mirror update movement admission without granting homing',async()=>{
 for(const mode of ['COPY','MIRROR'] as const){const t=await fixture();try{
  assert.throws(()=>t.port.setCarriageMode(1,mode,signal()),/homed/);assert.equal(t.port.status.failed,false);assert.equal(t.kinematics.status.homedAxes,'');
  t.kinematics.markHomed([0,1,2]);assert.throws(()=>t.port.setCarriageMode(1,mode,signal()),/homed/);
  await t.port.setCarriageMode(1,'PRIMARY',signal());t.kinematics.markHomed([0]);await t.port.setCarriageMode(0,'PRIMARY',signal());
  await t.port.setCarriageMode(1,mode,signal());assert.equal(t.port.carriageStatus!.carriages[1].mode,mode);assert.deepEqual(t.port.position(),[50,0,0,2]);
  t.port.move([50.1,0,0,2],10);await t.port.drain(signal());
  for(const oid of [3,5])assert.equal(t.f.fw.motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),10);
  const directions=[3,5].map(oid=>t.f.fw.motion.find(m=>m.name==='set_next_step_dir'&&m.parameters.oid===oid)!.parameters.dir);assert.equal(directions[0]===directions[1],mode==='COPY');
  assert.throws(()=>t.port.move([mode==='COPY'?91:111,0,0,2],10),/range/);
 }finally{await t.close();}}
});
test('failed stop leaves old carriage state and clears all homing authority',async()=>{
 const t=await fixture();try{
  t.kinematics.markHomed([0,1,2]);t.f.fw.setTriggerReason(4);await assert.rejects(t.port.setCarriageMode(1,'PRIMARY',signal()));
  assert.equal(t.port.carriageStatus!.primary,0);assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.throws(()=>t.port.move([51,0,0,2],10),/stopped/);
 }finally{await t.close();}
});

import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {GCodeMove} from '../src/gcode/move.ts';
// Emit a synthetic endstop hit only after the firmware clock reaches it.
// The host estimator may lead this clock; it cannot authorize a fake hit.
for(const [reverse,primary] of [[false,0],[true,0],[false,1]] as const)test(`dual carriage G28 follows physical rail order and restores primary (reverse=${reverse}, primary=${primary})`,async()=>{
 const t=await fixture(reverse);if(primary===1)await t.port.setCarriageMode(1,'PRIMARY',signal());const coordinates=new GCodeMove(t.port),carriage=t.port.carriageHoming!,ordinary={endstop:0,positiveDirection:false,speed:100,secondSpeed:50,retractSpeed:100,retractDistance:0,endstops:['other']};
 const command=new LinearHomingCommand(t.kinematics,coordinates,t.port,[carriage.rails[0],ordinary,ordinary],10000);let hits=0;const order:number[]=[];
 const timer=setInterval(()=>{
  if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);t.f.fw.setTriggerReason(2,9);return;}
  const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(arms.length<=hits)return;
  const arm=arms[hits],clock=BigInt(Number(arm.parameters.clock));if(BigInt(t.f.fw.currentClock())<clock)return;
  const second=Number(arm.parameters.oid)===6,trigger=second?9:8;hits++;order.push(second?1:0);
  t.f.fw.setTriggerReason(1,trigger);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},second?6:7);t.f.fw.emit('trsync_state',{oid:trigger,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{
  await command.home([0],signal());assert.deepEqual(order,reverse?[1,0]:[0,1]);assert.deepEqual(t.port.carriageStatus!.homed,[true,true]);assert.equal(t.port.carriageStatus!.primary,primary);assert.equal(t.kinematics.status.homedAxes,'x');assert.equal(t.port.position()[0],primary===1?220:reverse?200:0);assert.deepEqual(coordinates.state.position,t.port.position());assert.equal(t.f.stops,0);
 }finally{clearInterval(timer);await t.close();}
});

test('second carriage homing cancellation revokes the first completed carriage too',async()=>{
 const t=await fixture(),coordinates=new GCodeMove(t.port),carriage=t.port.carriageHoming!,ordinary={endstop:0,positiveDirection:false,speed:100,secondSpeed:50,retractSpeed:100,retractDistance:0,endstops:['other']},abort=new AbortController();
 const command=new LinearHomingCommand(t.kinematics,coordinates,t.port,[carriage.rails[0],ordinary,ordinary],10000);let hit=false,partial=false;
 const timer=setInterval(()=>{
  if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);t.f.fw.setTriggerReason(2,9);return;}
  const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);
  if(arms.length===2){partial=t.port.carriageStatus!.homed[0]&&!t.port.carriageStatus!.homed[1];abort.abort(new Error('cancel second carriage'));return;}
  if(hit||!arms.length)return;const arm=arms[0],clock=BigInt(Number(arm.parameters.clock));if(BigInt(t.f.fw.currentClock())<clock)return;
  hit=true;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{await assert.rejects(command.home([0],abort.signal),/cancel second carriage/);assert(partial);assert.deepEqual(t.port.carriageStatus!.homed,[false,false]);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(t.port.status.failed,true);}finally{clearInterval(timer);await t.close();}
});

test('dual carriage retract and second pass use each rail trigger and moving motor',async()=>{
 const t=await fixture(false,.2),coordinates=new GCodeMove(t.port),carriage=t.port.carriageHoming!,ordinary={endstop:0,positiveDirection:false,speed:100,secondSpeed:50,retractSpeed:100,retractDistance:0,endstops:['other']};
 const command=new LinearHomingCommand(t.kinematics,coordinates,t.port,[carriage.rails[0],ordinary,ordinary],10000);let hits=0;const order:number[]=[];
 const timer=setInterval(()=>{
  if(t.port.status.phase!=='seek'){
   t.f.fw.setTriggerReason(2,8);t.f.fw.setTriggerReason(2,9);
   if(t.port.status.phase==='retract'){const second=t.port.carriageStatus!.primary===1;t.f.fw.setStepperPosition(second?5:3,second?320:120);}return;
  }
  const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(arms.length<=hits)return;
  const arm=arms[hits],second=Number(arm.parameters.oid)===6,clock=BigInt(Number(arm.parameters.clock))+(hits%2?30000n:0n);if(BigInt(t.f.fw.currentClock())<clock)return;
  if(hits%2)t.f.fw.setStepperPosition(second?5:3,second?307:107);hits++;order.push(second?1:0);const trigger=second?9:8;
  t.f.fw.setTriggerReason(1,trigger);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},second?6:7);t.f.fw.emit('trsync_state',{oid:trigger,can_trigger:0,trigger_reason:1,clock:Number(clock)});
 },1);
 try{await command.home([0],signal());assert.deepEqual(order,[0,0,1,1]);assert.deepEqual(t.port.carriageStatus!.homed,[true,true]);assert.equal(t.port.position()[0],0);assert.equal(t.f.stops,0);}finally{clearInterval(timer);await t.close();}
});
