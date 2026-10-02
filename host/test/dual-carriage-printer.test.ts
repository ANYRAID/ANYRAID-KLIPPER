import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planLinearPrinter} from '../src/config/linear-printer.ts';
import {startClockedPrinter} from '../src/runtime/configured-printer.ts';
import {configuredPrinterFixture} from './helpers/configured-printer.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
const policy={mcus:['mcu','aux'],enableLeadTime:.001,fanMinimumScheduleTime:.001};
for(const [kind,axis] of [['cartesian','x'],['cartesian','y'],['hybrid_corexy','x'],['hybrid_corexz','x']] as const)test(`configured ${kind} ${axis} carriage starts, homes on two MCUs and moves selected motor`,async t=>{
 const triggerEvidence:{member:number;armClock:string;estimatedClock:string;firmwareClocks:number[]}[]=[];
 const f=await configuredPrinterFixture();let timer:ReturnType<typeof setInterval>|undefined;
 try{
  const raw=f.reader.source.original,reader=new ConfigurationReader(new ConfigurationSource('/idex.cfg',{...raw,printer:{...raw.printer,kinematics:kind},dual_carriage:{axis,position_min:'10',position_max:'220',position_endstop:'220',homing_speed:'100',homing_retract_dist:'0',safe_distance:'10',step_pin:'aux:PA6',dir_pin:'aux:PA7',endstop_pin:'aux:PA8',enable_pin:'!aux:PA9',rotation_distance:'40',microsteps:'16'}},[]),null),plan=planLinearPrinter(reader,policy);
  assert.equal(plan.layout.steppers.length,5);assert.equal(plan.motion.find(m=>m.emitter==='dual_carriage')!.mode,kind==='hybrid_corexy'?'corexy+':kind==='hybrid_corexz'?'corexz+':axis);
  const owner=await startClockedPrinter(reader,f.group,'mcu',plan.layout,{...f.options,hardware:{...f.options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear},f.signal);
  try{
   assert.equal(owner.linear.kinematics.status.homedAxes,'');assert.deepEqual(owner.linear.port.carriageStatus!.homed,[false,false]);assert(f.firmware.every(fw=>fw.motion.length===0));
   const seen=new Set<object>();let hits=0;
   timer=setInterval(()=>{
    if(owner.linear.port.status.phase!=='seek'){
     for(const h of owner.hardware.plan.homing)for(const t of h.triggers)f.firmware[t.mcu==='mcu'?0:1].setTriggerReason(2,t.protocol.oid);return;
    }
    for(let i=0;i<2;i++){
     const fw=f.firmware[i];for(const arm of fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0)){
      if(seen.has(arm))continue;const clock=BigInt(Number(arm.parameters.clock));
      // The host estimate can lead this simulated MCU. A firmware trigger must
      // not be emitted until its actual integer clock reaches the armed tick.
      if(f.group.session(i?'aux':'mcu').clock.sync.getClock(serialClock.now())<clock||BigInt(fw.currentClock())<clock)continue;
      if(triggerEvidence.length<64)triggerEvidence.push({member:i,armClock:clock.toString(),estimatedClock:f.group.session(i?'aux':'mcu').clock.sync.getClock(serialClock.now()).toString(),firmwareClocks:f.firmware.map(member=>member.currentClock())});
      seen.add(arm);hits++;const trigger=Number(arm.parameters.trsync_oid);fw.setTriggerReason(1,trigger);fw.setEndstopState({homing:0,pin_value:0,next_clock:Number(clock)+Number(arm.parameters.rest_ticks)},Number(arm.parameters.oid));fw.emit('trsync_state',{oid:trigger,can_trigger:0,trigger_reason:1,clock:Number(clock)});
     }
    }
   },1);
   await owner.print.gcode.homing.home([axis==='x'?0:1],f.signal);assert.equal(hits,2);assert.deepEqual(owner.linear.port.carriageStatus!.homed,[true,true]);
   await owner.linear.port.setCarriageMode(1,'PRIMARY',f.signal);const target=[...owner.linear.port.position()];target[axis==='x'?0:1]=219.9;
   const before=f.firmware[1].motion.length;owner.linear.port.move(target,10);await owner.linear.port.drain(f.signal);
   const oid=owner.initial.emitters.find(e=>e.id==='dual_carriage')!.settings.oid;assert.equal(f.firmware[1].motion.slice(before).filter(m=>m.name==='queue_step'&&m.parameters.oid===oid).reduce((n,m)=>n+Number(m.parameters.count),0),8);
  }catch(error){t.diagnostic(JSON.stringify({carriageTriggerEvidence:{kind,axis,triggerEvidence,firmwareClocksAtFailure:f.firmware.map(member=>member.currentClock()),hardwareFault:owner.hardware.status.fault,groupFault:f.group.status.fault,portFault:owner.linear.port.status.fault}}));throw new AggregateError([error,owner.hardware.status.fault,f.group.status.fault,owner.linear.port.status.fault],'Configured carriage journey failed');}finally{clearInterval(timer);await owner.close();}
 }finally{clearInterval(timer);await f.close();}
});
