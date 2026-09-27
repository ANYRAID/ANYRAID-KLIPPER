import test from 'node:test';
import assert from 'node:assert/strict';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startClockedPrinter} from '../src/runtime/configured-printer.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
for(const stuck of [false,true])test(`automatic BLTouch printer initializes and validates first Z hit (stuck=${stuck})`,async()=>{
 const f=await configuredPrinterFixture(),timers=new Set<ReturnType<typeof setTimeout>>();let owner:Awaited<ReturnType<typeof startClockedPrinter>>|undefined;
 try{
  const raw=structuredClone(f.reader.source.original);delete raw.stepper_z.position_endstop;raw.stepper_z.endstop_pin='probe:z_virtual_endstop';raw.bltouch={sensor_pin:'^PA13',control_pin:'aux:PA6',z_offset:'1.5'};
  const reader=new ConfigurationReader(new ConfigurationSource('/bltouch-printer.cfg',raw,[]),null),plan=planLinearPrinter(reader,{mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001});
  assert.equal(plan.linear.homing[2][0].section,'bltouch');assert.equal(plan.layout.homing.filter(h=>h.section==='bltouch').length,1);
  const fw=f.firmware[0],decoder=new FrameDecoder(),moving=new Map<number,boolean>();let hits=0;
  fw.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const c of fw.dictionary.parseFrame(frame)){
   const p=c.parameters;if(c.name==='trsync_start'){moving.set(Number(p.oid),Number(p.report_ticks)>0);if(!Number(p.report_ticks))fw.setTriggerReason(2,Number(p.oid));}
   if(c.name!=='endstop_home'||!Number(p.sample_count))continue;
   const motion=moving.get(Number(p.trsync_oid)),clock=Number(p.clock)+(motion&&!stuck?30000:0);
   const hit=()=>{fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:motion?0:Number(p.pin_value),next_clock:(clock+Number(p.rest_ticks))>>>0},Number(p.oid));if(motion){hits++;const stepper=fw.stepperConfigs.find(s=>s.step_pin===9||s.step_pin==='PA9');assert(stepper);fw.setStepperPosition(Number(stepper.oid),stuck?0:-5*hits);fw.emit('trsync_state',{oid:Number(p.trsync_oid),can_trigger:0,trigger_reason:1,clock});}};
   if(motion){const timer=setTimeout(()=>{timers.delete(timer);hit();},Math.max(0,(clock-fw.currentClock())/1000)+2);timers.add(timer);}else hit();
  }});
  owner=await startClockedPrinter(reader,f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  assert.equal(owner.hardware.bltouch!.device.status.phase,'idle');assert.equal(owner.linear.kinematics.status.homedAxes,'');owner.linear.kinematics.markHomed([0,1]);
  if(stuck){await assert.rejects(owner.print.gcode.homing.home([2],f.signal),/without motor movement/);assert.equal(owner.linear.kinematics.status.homedAxes,'');}
  else{await owner.print.gcode.homing.home([2],f.signal);assert.equal(owner.linear.kinematics.status.homedAxes,'xyz');assert.equal(owner.hardware.bltouch!.device.status.phase,'idle');assert.equal(owner.hardware.bltouch!.device.status.deployed,false);assert(owner.linear.port.position().every(Number.isFinite));}
  assert.equal(hits,1);
 }finally{for(const timer of timers)clearTimeout(timer);await owner?.close();await f.close();}
});
