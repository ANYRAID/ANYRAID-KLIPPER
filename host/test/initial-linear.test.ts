import test from 'node:test';
import assert from 'node:assert/strict';
import {initialLinearFixture} from './helpers/initial-linear.ts';
import {TrapQueue} from '../src/motion/trap-queue.ts';
import {LinearHomingCommand} from '../src/homing/linear-command.ts';
import {GCodeMove} from '../src/gcode/move.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {RebuiltMotionStreamer} from '../src/runtime/motion-streamer.ts';
import {LookAheadQueue,Move,motionLimits} from '../src/motion/lookahead.ts';
for(const reverse of [false,true])test(`toolhead time advances without reserving motion or mutating calibration, auxiliary first=${reverse}`,async()=>{
 const f=await initialLinearFixture(reverse);try{
  const g=f.initial.generation,{port}=f.initial.createLinearPort(f.reader,f.configuredSettings),member=g.clockMembers[0],now=serialClock.now();
  const before={coordinator:g.coordinator.status,source:g.source.status,calibrations:g.motion.bindings.map(b=>b.stepper.calibration),timelines:g.clockMembers.map(m=>m.timeline?.status),outputs:f.firmware.map(m=>m.outputs.length)};
  const first=port.estimatedPrintTime(now),later=port.estimatedPrintTime(now+1.25);assert.notEqual(first,null);assert.notEqual(later,null);
  const mapping=member.timeline?.status.calibration??member.calibration(),firstClock=member.session.clock.sync.getClock(now),laterClock=member.session.clock.sync.getClock(now+1.25);
  assert.equal(first,Number(firstClock)/mapping.frequency+mapping.offset);assert.equal(later,Number(laterClock)/mapping.frequency+mapping.offset);assert(later!>first!);
  assert.deepEqual({coordinator:g.coordinator.status,source:g.source.status,calibrations:g.motion.bindings.map(b=>b.stepper.calibration),timelines:g.clockMembers.map(m=>m.timeline?.status),outputs:f.firmware.map(m=>m.outputs.length)},before);
  for(const invalid of [NaN,Infinity,-1])assert.throws(()=>port.estimatedPrintTime(invalid),/observation/);assert.deepEqual(f.stops,[0,0]);
  await f.hardware.close();assert.equal(port.estimatedPrintTime(serialClock.now()),null);assert.deepEqual(f.stops,[1,1]);
 }finally{await f.hardware.close();await f.close();}
});
test('configured motor enables continue through a shared in-stream calibration',async()=>{
 const f=await initialLinearFixture();try{
  const g=f.initial.generation,clock=g.clockTimelines!.find(c=>c.id==='mcu')!.timeline,original=g.source.flushThrough.bind(g.source);let updated=false;
  g.source.flushThrough=async(until,...args)=>{
   const result=await original(until,...args);if(!updated){
    const limit=g.source.status.sourceTime-Math.max(...g.motion.bindings.map(b=>b.stepper.scanWindow.future))-.001,ids=g.motion.bindings.map(b=>b.id);
    // A newly generated pulse may round to the first exact anchor. Preserve
    // the rejected mapping, then inspect exactly one following candidate.
    for(let attempt=0;attempt<2&&!updated;attempt++){
     const plan=clock.planCalibration(g.coordinator.status.generatedTime,limit,1000100);assert(plan);
     const before=clock.status,calibrations=g.motion.bindings.map(b=>b.stepper.calibration),committed=g.coordinator.status.committedTime;
     g.coordinator.generateCalibrationBoundary(plan.time);
     try{clock.calibrateMotion(plan.tick,1000100,g.coordinator,ids);updated=true;}
     catch(error){
      if(attempt!==0||!(error instanceof RangeError)||error.message!=='Calibration would overlap previously accepted step clocks')throw error;
      assert.deepEqual(clock.status,before);assert.deepEqual(g.motion.bindings.map(b=>b.stepper.calibration),calibrations);assert.equal(g.coordinator.status.failed,false);
     }
     assert.equal(g.coordinator.status.committedTime,committed);g.assertMotorCalibration();
    }
    assert(updated);
   }return result;
  };
  const q=new LookAheadQueue();q.add(new Move(motionLimits(100,1000),[0,0,0,0],[20,0,0,0],20));await new RebuiltMotionStreamer(g).append(q.flush(),f.signal);await g.source.drain([],f.signal);
  assert(updated);assert.equal(g.motion.bindings.find(b=>b.id==='x')!.history.status.lastPlannedPosition,1600n);assert.deepEqual(f.stops,[0,0]);
 }finally{await f.hardware.close();await f.close();}
});
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
test('configured coordinate replacement retains shared clocks and the auxiliary output owner',async()=>{
 const f=await initialLinearFixture();try{
  const g=f.initial.generation,aux=f.hardware.plan.configurations.find(c=>c.mcu==='aux')!.timeline;
  assert.equal(g.clockTimelines!.find(c=>c.id==='aux')!.timeline,aux);assert.equal(g.auxiliaryMCUs[0].timeline,aux);
  const {port}=f.initial.createLinearPort(f.reader,f.configuredSettings),boundary=aux.status.reservedThrough+10000000n;aux.append(boundary,1000100);
  const view=g.clockMembers.find(c=>c.mcu==='aux')!;assert.equal(view.stepper.clockAt(aux.printTimeAtClock(boundary)+1),aux.clockAt(aux.printTimeAtClock(boundary)+1));
  await port.forcePosition([0,0,0,0],f.signal);await port.queueCoolingFan(.5,f.signal);await port.drain(f.signal);
  assert.equal(f.firmware[1].outputs.filter(o=>o.name==='queue_digital_out_generation'&&Number(o.parameters.on_ticks)>0).length>0,true);assert.deepEqual(f.stops,[0,0]);await f.hardware.close();
 }finally{await f.hardware.close();await f.close();}
});
