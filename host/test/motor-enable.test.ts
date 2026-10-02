import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {DigitalOutput} from '../src/outputs/digital.ts';
import {MotorEnable,compileMotorEnable} from '../src/outputs/motor-enable.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
import {PrintClockTimeline} from '../src/timing/print-clock-timeline.ts';
const signal=()=>new AbortController().signal,fixture=()=>nativeLinearFixture(0,()=>true,true,{kickStartTime:0,minimumScheduleTime:.001},true);
test('calibrated enable spans a clock boundary and reserves pulses through release guards',async()=>{
 const fw=await serialFirmware(),group=new MCUGroup([{id:'m',async connect(s:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const session=new SerialSession(fw.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){}}]);
 try{
  await group.start(signal());const chip={},timeline=new PrintClockTimeline({offset:0,frequency:1e6}),plan=compileMotorEnable(group,{mcu:'m',chip,pin:{chip,chipName:'m',pin:'PA3',invert:0,pullup:0},oid:0,emitters:['x'],leadTime:.01,calibration:{offset:0,frequency:1e6},timeline});
  await plan.session.configure({oidCount:1,commands:[plan.config.config],restart:[plan.config.restart],reservedMoves:plan.config.reservedMoves},signal());const power=new MotorEnable(group,[plan]);
  const boundary=plan.session.clock.sync.getClock(serialClock.now())+200000n;timeline.append(boundary,1000100);const first=boundary+5000n,last=first+1000n;
  const target=timeline.printTimeAtClock(first)-.01;let expected=timeline.clockAt(target);if(timeline.printTimeAtClock(expected)>target)expected--;
  await power.beforeSteps([{id:'x',messages:[],position:2n,history:new BigInt64Array([first,last,0n,2n,1000n,0n])}]);
  const enabled=fw.outputs.find(o=>o.name==='queue_digital_out');assert(enabled);assert.equal(BigInt(Number(enabled.parameters.clock)),expected);assert(expected<boundary);assert.equal(timeline.status.reservedThrough,last);
  assert.throws(()=>timeline.append(last,1e6),/reserved/);power.assertBindings(group,[{id:'x',mcu:'m',calibration:timeline.status.calibration}],timeline.printTimeAtClock(last));
  await power.disableAll(timeline.printTimeAtClock(last),signal());assert.equal(power.status.lines[0].enabled,false);assert(timeline.status.reservedThrough>last);assert.equal(fw.outputs.filter(o=>o.name==='queue_digital_out').length,2);
 }finally{await group.stop();await fw.close();}
});
test('shared driver enable is ACKed before steps and scheduled before the earliest filtered pulse',async()=>{
 const t=await fixture();try{
  const enable=()=>t.f.fw.outputs.filter(m=>m.name==='queue_digital_out'&&m.parameters.oid===10);assert.equal(enable().length,0);await t.port.queueCoolingFan(.5,signal());await t.port.drain(signal());assert.equal(enable().length,0);
  const plan=t.f.motorPlan!;assert.match(plan.config.config,/value=1 default_value=1 max_duration=0/);assert.equal(t.f.options.group.session('m').configuration.moveSlots,510);
  let first:bigint|undefined,ordered=true;for(const b of t.generation.motion.bindings){const flush=b.stepper.flushThrough.bind(b.stepper);b.stepper.flushThrough=time=>{const out=flush(time);for(let i=0;i<out.history.length;i+=6)if(out.history[i+3]!==0n&&(first===undefined||out.history[i]<first))first=out.history[i];return out;};}
  const push=t.f.fw.motion.push.bind(t.f.fw.motion);t.f.fw.motion.push=(...items)=>{if(items.some(m=>m.name==='queue_step'))ordered&&=enable().length===1;return push(...items);};
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2.1],10);await t.port.drain(signal());assert(ordered);assert(first!==undefined);assert.equal(enable().length,1);assert.equal(enable()[0].parameters.on_ticks,0);assert.equal(BigInt(Number(enable()[0].parameters.clock)),first-1000n);
  t.port.move([51.5,0,0,2.15],10);await t.port.drain(signal());assert.equal(enable().length,1);assert.equal(t.generation.motorEnable!.status.lines[0].enabled,true);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('normal drain and repeated rebuilds retain torque without duplicate enable commands',async()=>{
 const t=await fixture();try{t.kinematics.markHomed([0]);t.port.move([50.5,0,0,2],10);await t.port.drain(signal());for(let i=0;i<3;i++)await t.port.forcePosition([50,0,0,2],signal());t.port.move([51,0,0,2],10);await t.port.drain(signal());assert.equal(t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').length,1);assert.equal(t.f.stops,0);}finally{await t.close();}
});
test('enable failure fences every step packet and stops the MCU group',async()=>{
 const t=await fixture(),set=DigitalOutput.prototype.setDigital;DigitalOutput.prototype.setDigital=async()=>{throw new Error('enable wire failure');};try{t.kinematics.markHomed([0]);t.port.move([51,0,0,2],10);await assert.rejects(t.port.drain(signal()),/enable wire failure/);assert.equal(t.f.fw.motion.length,0);assert.equal(t.f.stops,1);assert.equal(t.generation.motorEnable!.status.stopped,true);}finally{DigitalOutput.prototype.setDigital=set;await t.close();}
});
test('late enable acknowledgement after a stop cannot publish enabled state or transmit steps',async()=>{
 const t=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),set=DigitalOutput.prototype.setDigital;DigitalOutput.prototype.setDigital=async function(...args){await set.apply(this,args);entered.resolve();await release.promise;};try{
  t.kinematics.markHomed([0]);t.port.move([51,0,0,2],10);const running=t.port.drain(signal()),failed=assert.rejects(running);await entered.promise;assert.equal(t.f.fw.motion.length,0);await t.generation.group.stop(new Error('stop during enable'));release.resolve();await failed;assert.equal(t.f.fw.motion.length,0);assert.equal(t.generation.motorEnable!.status.lines[0].enabled,false);assert.equal(t.f.stops,1);
 }finally{release.resolve();DigitalOutput.prototype.setDigital=set;await t.close();}
});
test('exhausted enable lead is rejected before writing a pin',async()=>{
 const t=await fixture();try{const now=t.generation.members[0].session.clock.sync.getClock(serialClock.now());await assert.rejects(t.generation.motorEnable!.beforeSteps([{id:'x',messages:[],position:1n,history:new BigInt64Array([now,now,0n,1n,0n,0n])}]),/lead time exhausted/);assert.equal(t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').length,0);assert.equal(t.f.stops,1);}finally{await t.close();}
});
test('a slow enable ACK cannot release motion after its packet lead expires',async()=>{
 const t=await fixture(),set=DigitalOutput.prototype.setDigital;DigitalOutput.prototype.setDigital=async function(...args){await set.apply(this,args);await new Promise(r=>setTimeout(r,300));};try{t.kinematics.markHomed([0]);t.port.move([51,0,0,2],10);await assert.rejects(t.port.drain(signal()),/lead exhausted/);assert.equal(t.f.fw.motion.length,0);assert.equal(t.f.stops,1);}finally{DigitalOutput.prototype.setDigital=set;await t.close();}
});
test('enable ownership cannot be reused or bound to missing motors and changed clocks',async()=>{
 const t=await fixture();try{const power=t.generation.motorEnable!,group=t.generation.group,b=t.generation.motion.bindings.map(b=>({id:b.id,mcu:'m',calibration:b.stepper.calibration}));assert.throws(()=>new MotorEnable(group,[t.f.motorPlan!]),/dedicated/);assert.throws(()=>new MotorEnable(group,[{...t.f.motorPlan!}]),/dedicated/);
  for(const pin of ['PA3','PA3_ALIAS']){const chip={},plan=compileMotorEnable(group,{mcu:'m',chip,pin:{chip,chipName:'m',pin,invert:1,pullup:0},oid:11,emitters:['other'],leadTime:.001,calibration:{offset:0,frequency:1e6}});assert.throws(()=>new MotorEnable(group,[plan]),/dedicated/);}
  assert.throws(()=>power.assertBindings(group,b.slice(1),1),/coverage/);assert.throws(()=>power.assertBindings(group,b.map(b=>({...b,calibration:{offset:0,frequency:999999}})),1),/clock differs/);assert.equal(t.f.stops,0);
 }finally{await t.close();}
});
test('two-pass homing retains shared motor power through seek, retract and recovery',async()=>{
 const t=await nativeLinearFixture(.2,()=>false,true,undefined,true);let hits=0;
 const timer=setInterval(()=>{if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);if(t.port.status.phase==='retract')t.f.fw.setStepperPosition(3,120);return;}const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(arms.length<=hits)return;const arm=arms[hits],clock=Number(arm.parameters.clock)+(hits?30000:0);if(t.generation.members[0].session.clock.sync.getClock(serialClock.now())<BigInt(clock))return;if(hits)t.f.fw.setStepperPosition(3,107);hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});},1);
 try{await t.command.home([0],signal());assert.equal(hits,2);assert.equal(t.kinematics.status.homedAxes,'x');t.port.move([51.5,0,0,2],10);await t.port.drain(signal());assert.equal(t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').length,1);assert.equal(t.generation.motorEnable!.status.lines[0].enabled,true);assert.equal(t.f.stops,0);}finally{clearInterval(timer);await t.close();}
});
for(const late of [false,true])test(`independent MCU driver enables ${late?'prevalidate every deadline before either write':'activate only the moving physical members'}`,async()=>{
 const fw=[await serialFirmware(),await serialFirmware()],stops=[0,0],ids=['a','b'],group=new MCUGroup(ids.map((id,i)=>({id,async connect(s:AbortSignal,stopDevice:(cause:unknown)=>Promise<void>){const session=new SerialSession(fw[i].fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops[i]++;}})));
 try{
  await group.start(signal());const plans=ids.map((mcu,i)=>{const chip={};return compileMotorEnable(group,{mcu,chip,emitters:[i?'e':'x'],pin:{chip,chipName:mcu,pin:'PA3',invert:0,pullup:0},oid:0,leadTime:.001,calibration:{offset:0,frequency:1e6}});});
  for(const p of plans)await p.session.configure({oidCount:1,commands:[p.config.config],restart:[p.config.restart],reservedMoves:p.config.reservedMoves},signal());const power=new MotorEnable(group,plans);
  const rows=plans.map((p,i)=>{const tick=p.session.clock.sync.getClock(serialClock.now())+BigInt(late&&i?0:200000);return {id:i?'e':'x',messages:[],position:1n,history:new BigInt64Array([tick,tick,0n,1n,0n,0n])};});
  if(late){await assert.rejects(power.beforeSteps(rows),/lead time exhausted/);assert.deepEqual(stops,[1,1]);assert(fw.every(f=>f.outputs.filter(o=>o.name==='queue_digital_out').length===0));}
  else{await power.beforeSteps(rows.slice(0,1));assert.deepEqual(power.status.lines.map(l=>l.enabled),[true,false]);assert.equal(fw[1].outputs.filter(o=>o.name==='queue_digital_out').length,0);await power.beforeSteps(rows);assert.deepEqual(power.status.lines.map(l=>l.enabled),[true,true]);assert(fw.every(f=>f.outputs.filter(o=>o.name==='queue_digital_out').length===1));
   await power.disableAll(0,signal());assert.deepEqual(power.status.lines.map(l=>l.enabled),[false,false]);for(const [i,p] of plans.entries()){const changes=fw[i].outputs.filter(o=>o.name==='queue_digital_out');assert.deepEqual(changes.map(c=>c.parameters.on_ticks),[1,0]);assert(p.session.clock.sync.lastClock>BigInt(Number(changes[1].parameters.clock))+100000n);}assert.deepEqual(stops,[0,0]);}
 }finally{await group.stop();for(const f of fw)await f.close();}
});
