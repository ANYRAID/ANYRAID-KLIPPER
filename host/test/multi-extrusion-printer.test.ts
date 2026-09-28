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
 }finally{if(timer)clearInterval(timer);await hardware?.close();await f.close();}
});
test('tool numbering rejects aliases and holes rather than silently assigning a different heater',()=>{
 const reader=(sections:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/tools.cfg',sections,[]),null);
 for(const sections of [{extruder:{},extruder0:{}},{extruder:{},extruder01:{}},{extruder:{},extruder2:{}}] as Record<string,Record<string,string>>[])assert.throws(()=>extrusionSections(reader(sections)),/topology/);
 assert.deepEqual(extrusionSections(reader({extruder2:{},extruder:{},extruder1:{}})),['extruder','extruder1','extruder2']);
});
