import {productObjects,type ProductServicePrinter} from '../src/runtime/product-objects.ts';
import {NativePauseParking} from '../src/operations/native-pause-parking.ts';
import {NativeLinearGCode} from '../src/runtime/native-linear-gcode.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {extrusionSections} from '../src/config/extrusion.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {initializeConfiguredMotion} from '../src/runtime/initial-motion.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};
for(const reverse of [false,true])test(`configured two-extruder motion binds independent heaters and queues, reverse=${reverse}`,async()=>{
 const f=await configuredPrinterFixture(reverse);let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 try{
  const original=f.reader.source.original,reader=new ConfigurationReader(new ConfigurationSource('/multi.cfg',{...original,extruder1:{...original.extruder,step_pin:'aux:PA6',dir_pin:'aux:PA7',enable_pin:'!aux:PA8',heater_pin:'aux:PA9',sensor_pin:'aux:PA10',max_extrude_only_velocity:'5'}},[]),null);
  const plan=planLinearPrinter(reader,policy);assert.deepEqual(plan.initial.routes,[{id:'xyz'},{id:'e',extrusionAxis:3},{id:'e1',extrusionAxis:4}]);assert(plan.layout.heaters.some(h=>h.section==='extruder1'));assert(plan.layout.homing.every(h=>h.mcus.includes('aux')));
  hardware=await startConfiguredHardware(reader,f.group,f.clocks,plan.layout,{...f.options.hardware,motion:plan.motion},f.signal);
  const initial=await initializeConfiguredMotion(hardware,plan.initial,f.signal),machine=initial.createLinearPort(reader,plan.linear),port=machine.port;
  assert.deepEqual(port.position(),[0,0,0,0,0]);assert.equal(machine.kinematics.status.homedAxes,'');
  await assert.rejects(machine.createPrint(f.options.print),/tool-selection/);
  assert.throws(()=>port.move([0,0,0,0,.1],5),/temperature/);assert.equal(port.status.failed,false);
  let secondHot=false;
  const emit=()=>{for(const section of ['extruder','extruder1']){const h=hardware!.plan.heaters.find(h=>h.section===section)!;const temperature=section==='extruder'||secondHot?200:20,raw=Math.round(h.configuration.converter.adc(temperature)*h.sensor.adc.maximumSum),session=f.group.session('aux'),next=session.clock.sync.getClock(serialClock.now())+292000n;f.firmware[1].emit('analog_in_state',{oid:h.sensor.adc.oid,next_clock:Number(BigInt.asUintN(32,next)),values:Buffer.from([raw&255,raw>>8])});}};
  emit();timer=setInterval(emit,20);const first=hardware.thermal.find(h=>h.section==='extruder')!.runtime,second=hardware.thermal.find(h=>h.section==='extruder1')!.runtime;
  let deadline=performance.now()+3000;while(!first.canExtrude()){assert(performance.now()<deadline);await delay(10);}assert.equal(second.canExtrude(),false);
  assert.throws(()=>port.move([0,0,0,0,.1],5),/temperature/);
  secondHot=true;deadline=performance.now()+3000;while(!second.canExtrude()){assert(performance.now()<deadline);await delay(10);}
  const before=f.firmware.map(fw=>fw.motion.length);port.move([0,0,0,0,.1],20);await port.drain(f.signal);
  const e1=hardware.plan.steppers.find(s=>s.emitter==='e1')!;
  assert.equal(f.firmware[0].motion.slice(before[0]).filter(m=>m.name==='queue_step').length,0);
  const steps=f.firmware[1].motion.slice(before[1]).filter(m=>m.name==='queue_step');assert.equal(steps.reduce((n,m)=>n+Number(m.parameters.count),0),8);assert(steps.every(m=>m.parameters.oid===e1.compressor.oid));
  assert.deepEqual(port.position(),[0,0,0,0,.1]);
  await port.forcePosition([1,2,3,0,.1],f.signal);assert.deepEqual(port.position(),[1,2,3,0,.1]);
  port.move([1,2,3,0,.2],5);await port.drain(f.signal);assert.deepEqual(port.position(),[1,2,3,0,.2]);
  assert.throws(()=>new NativeLinearGCode(port,machine.kinematics,machine.rails,()=>{},120000,1,undefined,undefined,undefined,false,[],[{name:'extruder',stepper:'e1'},{name:'extruder1',stepper:'e'}]),/bindings/);
  const gcode=new NativeLinearGCode(port,machine.kinematics,machine.rails,()=>{},120000,1,{retract_length:.1,retract_speed:5,unretract_extra_length:0,unretract_speed:5},undefined,undefined,true,[],machine.toolBindings);
  try{
   gcode.enable();await gcode.dispatch.execute('T1\nM83\nG1 E0.1 F300\nG10');assert.equal(gcode.tools!.active,1);assert.equal(gcode.retraction!.retracted,true);assert.equal(gcode.pressureAdvance!.name,'extruder1');
   const afterSecond=[...port.position()];assert.equal(afterSecond[3],0);assert(Math.abs(afterSecond[4]-.2)<1e-12);
   await gcode.dispatch.execute('T0\nG1 E0.1 F300\nG11');assert.equal(gcode.retraction!.retracted,false);assert(Math.abs(port.position()[3]-.1)<1e-12);assert.equal(port.position()[4],afterSecond[4]);
   await gcode.dispatch.execute('ACTIVATE_EXTRUDER EXTRUDER=extruder1\nG11');assert.equal(gcode.retraction!.retracted,false);assert(Math.abs(port.position()[4]-.3)<1e-12);
   await gcode.dispatch.execute('SET_PRESSURE_ADVANCE ADVANCE=0.05\nSET_PRESSURE_ADVANCE EXTRUDER=extruder ADVANCE=0.02');assert.equal(port.pressureAdvanceSettings('e1').advance,.05);assert.equal(port.pressureAdvanceSettings('e').advance,.02);
   const beforeHome=port.position().slice(3),h=hardware.plan.homing.find(h=>h.section==='stepper_x')!;let sent=false;
   const homeTimer=setInterval(()=>{const arm=f.firmware[0].outputs.find(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0);if(!arm||sent)return;const clock=BigInt(Number(arm.parameters.clock));if(f.group.session('mcu').clock.sync.getClock(serialClock.now())<clock)return;sent=true;
    f.firmware[0].setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},h.endstop.oid);
    for(const trigger of h.triggers){const fw=f.firmware[trigger.mcu==='mcu'?0:1],oid=trigger.protocol.oid;fw.setTriggerReason(1,oid);fw.emit('trsync_state',{oid,can_trigger:0,trigger_reason:1,clock:Number(clock)});}
   },1);
   try{await gcode.dispatch.execute('G28 X');assert(sent);assert.equal(machine.kinematics.status.homedAxes,'x');assert.deepEqual(port.position().slice(3),beforeHome);assert.equal(gcode.coordinates.state.position.length,4);assert.equal(gcode.coordinates.state.position[3],beforeHome[1]);}finally{clearInterval(homeTimer);}
   const parkedFrom=[...port.position()],parking=new NativePauseParking(port,{parkXY:[parkedFrom[0],parkedFrom[1]],lift:0,retract:.05,travelSpeed:5,liftSpeed:5,retractSpeed:5},undefined,()=>3+gcode.tools!.active);
   const pauseWire=f.firmware.map(fw=>fw.motion.length);await parking.pause(f.signal);assert.deepEqual(port.position(),parkedFrom);
   const pulses=()=>f.firmware[1].motion.slice(pauseWire[1]).filter(m=>m.name==='queue_step'&&m.parameters.oid===e1.compressor.oid).reduce((n,m)=>n+Number(m.parameters.count),0);assert.equal(pulses(),4);assert.equal(f.firmware[0].motion.slice(pauseWire[0]).filter(m=>m.name==='queue_step').length,0);
   await parking.resume(f.signal);assert.equal(pulses(),8);assert.deepEqual(port.position(),parkedFrom);
   const beforeExclude=[...port.position()],wireBefore=f.firmware.map(fw=>fw.motion.length);
   await gcode.dispatch.execute('M83\nEXCLUDE_OBJECT NAME=skip\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nG1 E0.0125\nEXCLUDE_OBJECT_START NAME=skip\nG1 E0.125\nT0\nG1 E0.25\nEXCLUDE_OBJECT_END\nG1 E0.0125\nT1\nG1 E0.0125');
   assert(Math.abs(port.position()[3]-beforeExclude[3]-.0125)<1e-12);assert(Math.abs(port.position()[4]-beforeExclude[4]-.075)<1e-12);
   const emitted=f.firmware.map((fw,i)=>fw.motion.slice(wireBefore[i]).filter(m=>m.name==='queue_step').reduce((n,m)=>n+Number(m.parameters.count),0));assert.deepEqual(emitted,[1,6]);
   const objects=productObjects({machine,hardware,print:{gcode},filamentSensors:[]} as unknown as ProductServicePrinter,()=>{throw Error('Unexpected host query');});
   let status=objects.query({toolhead:['extruder','position'],extruder:['pressure_advance'],extruder1:['pressure_advance'],firmware_retraction:['retract_length']}).status;
   assert.equal(status.toolhead.extruder,'extruder1');assert.deepEqual(status.toolhead.position,[...port.homingPosition().slice(0,3),port.homingPosition()[4]]);assert.equal(status.extruder.pressure_advance,.02);assert.equal(status.extruder1.pressure_advance,.05);
   await gcode.dispatch.execute('SET_RETRACTION RETRACT_LENGTH=0.2\nT0');status=objects.query({toolhead:['extruder'],firmware_retraction:['retract_length']}).status;assert.equal(status.toolhead.extruder,'extruder');assert.equal(status.firmware_retraction.retract_length,.1);
   gcode.objects!.finish();assert.equal(gcode.tools!.hasObjectExclusion,false);

  }finally{await gcode.close();}
 }finally{if(timer)clearInterval(timer);await hardware?.close();await f.close();}
});
test('tool numbering rejects aliases and holes rather than silently assigning a different heater',()=>{
 const reader=(sections:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/tools.cfg',sections,[]),null);
 for(const sections of [{extruder:{},extruder0:{}},{extruder:{},extruder01:{}},{extruder:{},extruder2:{}}] as Record<string,Record<string,string>>[])assert.throws(()=>extrusionSections(reader(sections)),/topology/);
 assert.deepEqual(extrusionSections(reader({extruder2:{},extruder:{},extruder1:{}})),['extruder','extruder1','extruder2']);
});
