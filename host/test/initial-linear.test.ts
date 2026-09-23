import test from 'node:test';
import assert from 'node:assert/strict';
import {initialLinearFixture} from './helpers/initial-linear.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {setTimeout as delay} from 'node:timers/promises';
for(const reverse of [false,true])test(`configured linear handoff homes and closes replacement generations, auxiliary first=${reverse}`,async()=>{
 const created:ReturnType<TrapQueue['createStepper']>[]=[],original=TrapQueue.prototype.createStepper;
 TrapQueue.prototype.createStepper=function(...args){const stepper=original.apply(this,args);created.push(stepper);return stepper;};
 let timer:ReturnType<typeof setInterval>|undefined;
 const f=await initialLinearFixture(reverse);try{
  const {port,kinematics,rails}=f.initial.createLinearPort(f.reader,f.configuredSettings);
  assert.equal(kinematics.status.homedAxes,'');assert.throws(()=>port.move([1,0,0,0],10),/home/i);assert.throws(()=>port.move([0,0,0,1],10),/temperature/);
  assert.throws(()=>f.initial.createLinearPort(f.reader,f.configuredSettings),/owned/);
  const h=f.hardware.plan.homing[0];let sent=false;
  timer=setInterval(()=>{
   const arm=f.firmware[0].outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0);if(!arm||sent)return;
   const clock=BigInt(Number(arm.parameters.clock));if(f.initial.generation.members[0].session.clock.sync.getClock(serialClock.now())<clock)return;sent=true;
   const oid=h.triggers[0].protocol.oid;f.firmware[0].setTriggerReason(1,oid);f.firmware[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},h.endstop.oid);f.firmware[0].emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock:Number(clock)});
  },1);
  const command=new LinearHomingCommand(kinematics,new GCodeMove(port),port,rails,5000);await command.home([0],f.signal);assert(sent);clearInterval(timer);timer=undefined;
  assert.equal(kinematics.status.homedAxes,'x');assert.deepEqual(port.position(),[0,0,0,0]);
  const before=f.firmware[0].motion.length;port.move([1,0,0,0],10);await port.drain(f.signal);
  const oid=f.hardware.plan.steppers.find(s=>s.emitter==='x')!.compressor.oid;
  assert.equal(f.firmware[0].motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),80);
  assert(created.length>4);await f.hardware.close();assert.equal(port.status.failed,true);assert.equal(kinematics.status.homedAxes,'');for(const stepper of created)assert.throws(()=>stepper.calibration,/closed/);assert.deepEqual(f.stops,[1,1]);
 }finally{if(timer)clearInterval(timer);TrapQueue.prototype.createStepper=original;await f.hardware.close();await f.close();}
});
test('invalid linear semantics may be corrected before the single handoff',async()=>{
 const f=await initialLinearFixture();try{
  assert.throws(()=>f.initial.createLinearPort(f.reader,{...f.settings,kinematicIds:['y','x','z']}),/solvers/);assert.deepEqual(f.stops,[0,0]);
  const {port}=f.initial.createLinearPort(f.reader,f.configuredSettings);await f.hardware.close();assert.equal(port.status.failed,true);
 }finally{await f.close();}
});
test('a source already seeded by another producer cannot be handed to the linear port',async()=>{
 const f=await initialLinearFixture();try{
  f.initial.generation.source.append([]);assert.throws(()=>f.initial.createLinearPort(f.reader,f.configuredSettings),/used/);assert.deepEqual(f.stops,[0,0]);await f.hardware.close();
 }finally{await f.close();}
});
test('hardware close cancels and waits for an in-flight coordinate replacement',async()=>{
 const f=await initialLinearFixture();try{
  const {port}=f.initial.createLinearPort(f.reader,f.configuredSettings),before=f.firmware[0].outputs.filter(o=>o.name==='stepper_stop_on_trigger').length;
  f.firmware[0].ignore('stepper_get_position');const pending=port.forcePosition([1,0,0,0],f.signal),rejected=assert.rejects(pending);
  const deadline=performance.now()+2000;while(f.firmware[0].outputs.filter(o=>o.name==='stepper_stop_on_trigger').length===before){assert(performance.now()<deadline);await delay(2);}
  await f.hardware.close();await rejected;assert.equal(port.status.busy,false);assert.equal(port.status.failed,true);assert.equal(f.hardware.status.state,'stopped');assert.deepEqual(f.stops,[1,1]);
  for(const b of f.initial.generation.motion.bindings)assert.throws(()=>b.stepper.calibration,/closed/);
 }finally{await f.hardware.close();await f.close();}
});
test('owned port reads live configured ADC temperature and ignores caller permission overrides',async()=>{
 const f=await initialLinearFixture();let timer:ReturnType<typeof setInterval>|undefined;
 try{
  const {port}=f.initial.createLinearPort(f.reader,{...f.settings,canExtrude:()=>true} as typeof f.settings);
  assert.throws(()=>port.move([0,0,0,1],2),/temperature/);
  const plan=f.hardware.plan.heaters[0],runtime=f.hardware.analog[0].runtime,session=f.group.session(plan.sensor.mcu);let temperature=220;
  const emit=()=>{const raw=Math.round(plan.configuration.converter.adc(temperature)*plan.sensor.adc.maximumSum),next=session.clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:plan.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});};
  timer=setInterval(emit,50);emit();const warmDeadline=performance.now()+4000;
  while(!runtime.canExtrude()){assert(performance.now()<warmDeadline,'fresh ADC samples did not enable extrusion');await delay(10);}
  port.move([0,0,0,.1],2);await port.drain(f.signal);
  const e=f.hardware.plan.steppers.find(s=>s.emitter==='e')!;
  assert.equal(f.firmware[0].motion.filter(m=>m.name==='queue_step'&&m.parameters.oid===e.compressor.oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
  temperature=25;const coolDeadline=performance.now()+4000;while(runtime.canExtrude()){assert(performance.now()<coolDeadline,'cooling did not revoke extrusion');await delay(10);}
  assert.throws(()=>port.move([0,0,0,.2],2),/temperature/);assert.deepEqual(port.position(),[0,0,0,.1]);
 }finally{if(timer)clearInterval(timer);await f.hardware.close();await f.close();}
});
