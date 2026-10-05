import test from 'node:test';
import assert from 'node:assert/strict';
import {nativePrintFixture} from './helpers/native-linear-print.ts';
import {createNativeLinearPrint} from '../src/operations/native-linear-print.ts';
import {compileConfiguredMotorEnables} from '../src/config/motor-enable.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture} from './helpers/configured-steppers.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
import type {MCUGroup} from '../src/runtime/mcu-group.ts';
import {MotorEnable} from '../src/outputs/motor-enable.ts';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
const signal=()=>new AbortController().signal;
for(const mode of ['always','mixed'] as const){
 test(`configured ${mode} motors stream and finish a print without claiming software power-off`,async()=>{
  const f=await nativePrintFixture('G1 X51 E2.01 F600\n',false,mode);let owner:Awaited<ReturnType<typeof createNativeLinearPrint>>|undefined;
  try{
   f.options.motorCompletion='release';await assert.rejects(createNativeLinearPrint(f.options),/motor completion policy/);assert.equal(f.t.f.stops,0);assert.equal(f.heaters.status.closed,false);
   f.options.motorCompletion='hold';owner=await createNativeLinearPrint(f.options);const eof=Promise.withResolvers<void>();owner.device.subscribeEOF(()=>eof.resolve());owner.device.subscribeFault(e=>eof.reject(e));
   await owner.device.prepare({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60},signal());await owner.device.start('file',signal());await eof.promise;await owner.device.finish('job',signal());
   assert.equal(f.outputFinishes,1);assert.deepEqual(f.resetCounts,[2,2]);assert.equal(f.t.port.status.failed,false);assert.equal(f.t.generation.motion.bindings[0].history.status.lastPlannedPosition,200n);
   const power=f.t.generation.motorEnable!;assert.equal(power.canReleaseAll,false);assert.equal(power.status.alwaysOn.length,mode==='always'?4:1);assert.deepEqual(f.t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').map(m=>m.parameters.on_ticks),mode==='always'?[]:[0]);
   const previous=f.t.kinematics.status.homedAxes;await assert.rejects(f.t.port.releaseMotors(signal()),/Always-on/);await assert.rejects(power.disableAll(0,signal()),/Always-on/);assert.equal(f.t.kinematics.status.homedAxes,previous);assert.equal(f.t.f.stops,0);
   await f.t.generation.group.stop(new Error('test stop'));assert.equal(power.status.stopped,true);assert.equal(power.status.alwaysOn.length,mode==='always'?4:1);
  }finally{await owner?.close();await f.close();}
 });
 test(`M84 rejection with ${mode} motors preserves admission and homing authority`,async()=>{
  const f=await nativePrintFixture('',false,mode);
  try{f.gcode.enable();f.t.kinematics.markHomed([0,1,2]);await assert.rejects(f.gcode.dispatch.execute('M84'),/Always-on/);assert.equal(f.t.port.status.failed,false);assert.equal(f.t.kinematics.status.homedAxes,'xyz');await f.gcode.dispatch.execute('G1 X51 F600');await f.t.port.drain(signal());assert.equal(f.t.port.position()[0],51);assert.equal(f.t.f.stops,0);
   const power=f.t.generation.motorEnable!,bindings=f.t.generation.motion.bindings.map(b=>({id:b.id,mcu:'m',calibration:b.stepper.calibration}));assert.throws(()=>power.assertBindings(f.t.generation.group,bindings.slice(1),1),/coverage/);assert.throws(()=>power.assertBindings(f.t.generation.group,bindings.map(b=>({...b,calibration:{offset:0,frequency:999999}})),1),/clock differs/);
   await f.t.port.forcePosition([50,0,0,2],signal());assert.equal(f.t.generation.motorEnable,power);assert.equal(f.t.f.stops,0);
  }finally{await f.close();}
 });
}
test('always-on compilation allocates no objects, snapshots clocks and rejects repeated owners',()=>{
 const f=stepperBatchFixture(),session={dictionary:f.dictionary,status:{configured:true}},group={session:()=>session,assertActive(){},subscribeStop(){return ()=>{};}} as unknown as MCUGroup;
 const reader=new ConfigurationReader(new ConfigurationSource('/always.cfg',{x:{}},[]),null),request={section:'x',emitter:'x',mcu:'mcu',leadTime:.001,calibration:{offset:0,frequency:1e6}};
 const plans=compileConfiguredMotorEnables(reader,f.pins,group,[request]);assert.equal(plans.lines.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);assert.equal(f.pins.claimedPins.length,0);request.calibration.frequency=2e6;assert.equal(plans.alwaysOn[0].clock.frequency,1e6);
 assert.throws(()=>compileConfiguredMotorEnables(reader,f.pins,group,[request]),/Duplicate/);assert.throws(()=>new MotorEnable(group,[],[{...plans.alwaysOn[0]}]),/ownership/);
 const power=new MotorEnable(group,[],plans.alwaysOn);assert.equal(power.canReleaseAll,false);assert.throws(()=>new MotorEnable(group,[],plans.alwaysOn),/ownership/);
});
test('mixed configuration failure does not reserve always-on members prematurely',()=>{
 const f=stepperBatchFixture(),group={session:()=>({dictionary:f.dictionary})} as unknown as MCUGroup,requests=['x','y'].map(id=>({section:id,emitter:id,mcu:'mcu',leadTime:.001,calibration:{offset:0,frequency:1e6}}));
 const reader=(pin:string)=>new ConfigurationReader(new ConfigurationSource('/mixed.cfg',{x:{},y:{enable_pin:pin}},[]),null);
 assert.throws(()=>compileConfiguredMotorEnables(reader('MISSING'),f.pins,group,requests),/Unknown/);assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 const plans=compileConfiguredMotorEnables(reader('PA3'),f.pins,group,requests);assert.equal(plans.alwaysOn.length,1);assert.equal(plans.lines[0].config.oid,0);
});
test('always-on motors complete filtered two-pass homing and resume without digital transitions',async()=>{
 const t=await nativeLinearFixture(.2,()=>false,true,undefined,'always');let hits=0;
 const timer=setInterval(()=>{if(t.port.status.phase!=='seek'){t.f.fw.setTriggerReason(2,8);if(t.port.status.phase==='retract')t.f.fw.setStepperPosition(3,120);return;}const arms=t.f.fw.outputs.filter(m=>m.name==='endstop_home'&&Number(m.parameters.sample_count)>0);if(arms.length<=hits)return;const arm=arms[hits],clock=Number(arm.parameters.clock)+(hits?30000:0);if(BigInt(t.f.fw.currentClock())<BigInt(clock))return;if(hits)t.f.fw.setStepperPosition(3,107);hits++;t.f.fw.setTriggerReason(1,8);t.f.fw.setEndstopState({homing:0,pin_value:0,next_clock:clock+Number(arm.parameters.rest_ticks)},7);t.f.fw.emit('trsync_state',{oid:8,can_trigger:0,trigger_reason:1,clock});},1);
 try{await t.command.home([0],signal());assert.equal(hits,2);assert.equal(t.kinematics.status.homedAxes,'x');t.port.move([51.5,0,0,2],10);await t.port.drain(signal());assert.equal(t.f.fw.outputs.filter(m=>m.name==='queue_digital_out').length,0);assert.equal(t.generation.motorEnable!.status.alwaysOn.length,4);assert.equal(t.f.stops,0);}finally{clearInterval(timer);await t.close();}
});
