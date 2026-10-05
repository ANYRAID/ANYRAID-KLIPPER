import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import {DigitalOutput} from '../src/outputs/digital.ts';
const signal=()=>new AbortController().signal,rails=[51,0,0].map(endstop=>({endstop,positiveDirection:false,speed:10,retractDistance:0,retractSpeed:10,secondSpeed:5,endstops:['test']}));
async function fixture(power=true){const t=await nativeLinearFixture(0,()=>true,true,{kickStartTime:0,minimumScheduleTime:.001},power),g=new NativeLinearGCode(t.port,t.kinematics,rails,()=>{});g.enable();t.kinematics.markHomed([0,1,2]);return {t,g,writes:()=>t.f.fw.outputs.filter(m=>m.name==='queue_digital_out'),close:async()=>{await g.close();await t.close();}};}
test('M84 drains queued motion, preserves the fan, and confirms MCU time on both sides of disable',async()=>{
 const f=await fixture();try{
  await f.g.dispatch.execute('M106 S128\nG1 X51 E2.1 F600\nM84');const changes=f.writes();assert.deepEqual(changes.map(c=>c.parameters.on_ticks),[0,1]);const off=BigInt(Number(changes[1].parameters.clock));assert(off>=f.t.generation.motion.bindings[0].history.status.throughClock+100000n);assert(f.t.generation.members[0].session.clock.sync.lastClock>off+100000n);
  assert.equal(f.t.generation.motorEnable!.status.lines[0].enabled,false);assert.equal(f.t.kinematics.status.homedAxes,'');assert.equal(f.t.port.status.failed,false);assert.equal(f.t.f.stops,0);assert.deepEqual(f.t.f.fw.outputs.filter(m=>m.name==='queue_pwm_out_generation').map(m=>m.parameters.value),[128]);
  await f.g.dispatch.execute('M107');assert.equal(f.writes().length,2);assert.equal(f.t.f.stops,0);
 }finally{await f.close();}
});
test('M18 aliases normal all-motor release and repeated idle releases do not toggle pins',async()=>{
 const f=await fixture();try{await f.g.dispatch.execute('M18\nM84');assert.equal(f.writes().length,0);assert.equal(f.t.kinematics.status.homedAxes,'');f.t.kinematics.markHomed([0]);await f.g.dispatch.execute('G1 X51 F600\nM18\nM84\nM18');assert.deepEqual(f.writes().map(c=>c.parameters.on_ticks),[0,1]);assert.equal(f.t.f.stops,0);}finally{await f.close();}
});
test('motion after release requires a new homing operation before another enable',async()=>{
 const f=await fixture();try{await f.g.dispatch.execute('G1 X51 F600\nM84');const count=f.t.f.fw.motion.length;await assert.rejects(f.g.dispatch.execute('G1 X51.5'),/home/i);assert.equal(f.t.f.fw.motion.length,count);assert.equal(f.writes().length,2);}finally{await f.close();}
});
test('release followed by G28 safely re-enables the retained driver owner and resumes motion',async()=>{
 const f=await fixture();let hit=false;const timer=setInterval(()=>{const arm=f.t.f.fw.outputs.find(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(!arm||hit)return;const clock=Number(arm.parameters.clock);if(BigInt(f.t.f.fw.currentClock())<BigInt(clock))return;hit=true;f.t.f.fw.setTriggerReason(1,8);f.t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);f.t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});},1);
 try{await f.g.dispatch.execute('G1 X51 F600\nM84');f.t.f.fw.setStepperPosition(3,200);await f.g.dispatch.execute('G28 X\nG1 X51.5 F600');assert(hit);assert.equal(f.t.kinematics.status.homedAxes,'x');assert.deepEqual(f.writes().map(c=>c.parameters.on_ticks),[0,1,0]);assert(Number(f.writes()[2].parameters.clock)>=Number(f.writes()[1].parameters.clock)+100000);assert.equal(f.t.port.position()[0],51.5);assert.equal(f.t.f.stops,0);}finally{clearInterval(timer);await f.close();}
});
test('release never publishes completion before the off acknowledgement',async()=>{
 const f=await fixture(),set=DigitalOutput.prototype.setDigital,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();try{
  await f.g.dispatch.execute('G1 X51 F600');DigitalOutput.prototype.setDigital=async function(...args){await set.apply(this,args);if(!args[1]){entered.resolve();await release.promise;}};let done=false;const running=f.t.port.releaseMotors(signal()).then(()=>{done=true;});await entered.promise;assert.equal(f.t.kinematics.status.homedAxes,'');await delay(230);assert.equal(done,false);assert.equal(f.t.generation.motorEnable!.status.lines[0].enabled,true);release.resolve();await running;assert.equal(f.t.generation.motorEnable!.status.lines[0].enabled,false);assert.equal(f.t.f.stops,0);
 }finally{release.resolve();DigitalOutput.prototype.setDigital=set;await f.close();}
});
test('cancellation during release fences late acknowledgements and stops the group',async()=>{
 const f=await fixture(),set=DigitalOutput.prototype.setDigital,entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),cancel=new AbortController();try{
  await f.g.dispatch.execute('G1 X51 F600');DigitalOutput.prototype.setDigital=async function(...args){await set.apply(this,args);if(!args[1]){entered.resolve();await release.promise;}};const running=f.t.port.releaseMotors(cancel.signal),failed=assert.rejects(running);await entered.promise;cancel.abort(new Error('cancel motor release'));await f.t.generation.group.stop(cancel.signal.reason);release.resolve();await failed;assert.equal(f.t.port.status.failed,true);assert.equal(f.t.generation.motorEnable!.status.stopped,true);assert.equal(f.t.f.stops,1);
 }finally{release.resolve();DigitalOutput.prototype.setDigital=set;await f.close();}
});
test('failed disable delivery stops the group instead of reporting motors released',async()=>{
 const f=await fixture(),set=DigitalOutput.prototype.setDigital;try{await f.g.dispatch.execute('G1 X51 F600');DigitalOutput.prototype.setDigital=async function(...args){if(!args[1])throw new Error('disable failed');return set.apply(this,args);};await assert.rejects(f.t.port.releaseMotors(signal()),/disable failed/);assert.equal(f.t.f.stops,1);assert.equal(f.t.port.status.failed,true);assert.equal(f.t.kinematics.status.homedAxes,'');}finally{DigitalOutput.prototype.setDigital=set;await f.close();}
});
test('clock drift cannot move a release request onto a stale peripheral mapping',async()=>{
 const f=await fixture();try{await f.g.dispatch.execute('G1 X51 F600');f.t.generation.motion.bindings[0].stepper.calibrateClock(0,1000001);await assert.rejects(f.t.port.releaseMotors(signal()),/calibration changed/);assert.equal(f.writes().length,1);assert.equal(f.t.f.stops,1);}finally{await f.close();}
});
for(const [configured,command] of [[false,'M84'],[true,'M84 S30']] as const)test(`release rejects unsupported configuration or parameters (${command}, configured=${configured})`,async()=>{
 const f=await fixture(configured);try{await assert.rejects(f.g.dispatch.execute(command),/Unsupported command|parameters are unsupported/);assert.equal(f.writes().length,0);assert.equal(f.t.port.status.failed,!configured);}finally{await f.close();}
});
