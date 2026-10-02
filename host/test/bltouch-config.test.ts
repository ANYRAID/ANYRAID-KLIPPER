import {FrameDecoder} from '../src/protocol/codec.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readBLTouchSettings} from '../src/config/bltouch.ts';
import {compileConfiguredHardware,type HardwareLayout} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {hardwareFixture,hardwareClocks} from './helpers/configured-hardware.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
const reader=(options:Record<string,string>={},extra:Record<string,Record<string,string>>={})=>new ConfigurationReader(new ConfigurationSource('/bltouch.cfg',{bltouch:{sensor_pin:'^PA0',control_pin:'aux:PA1',z_offset:'1.5',...options},...extra},[]),null);
const layout:HardwareLayout={steppers:[],homing:[{section:'bltouch',mcus:['mcu','aux']}],fans:[],heaters:[]};
test('BLTouch settings preserve defaults and reject conflicting probe and macro ownership',()=>{
 assert.deepEqual(readBLTouchSettings(reader()),{pinMoveTime:.68,stowOnEachSample:true,touchMode:false,pinUpNotTriggered:true,pinUpTouchTriggered:true,outputMode:null});
 assert.equal(readBLTouchSettings(reader({set_output_mode:'5V',stow_on_each_sample:'false'}))!.stowOnEachSample,false);
 for(const change of [{pin_move_time:'0'},{set_output_mode:'auto'},{activate_gcode:'G1 Z1'}] as Record<string,string>[])assert.throws(()=>readBLTouchSettings(reader(change)));
 assert.throws(()=>readBLTouchSettings(reader({}, {probe:{pin:'PA2'}})),/same probe/);
});
test('control and sensor may use different MCUs while verification keeps a distinct OID',()=>{
 const f=hardwareFixture(),plan=compileConfiguredHardware(reader(),f.group,hardwareClocks(),layout),b=plan.bltouch!;
 assert.equal(b.output.mcu,'aux');assert.equal(b.verification.mcu,'mcu');assert.strictEqual(b.sensor,plan.homing[0]);assert(!b.sensor.triggers.filter(t=>t.mcu==='mcu').some(t=>t.protocol.oid===b.verification.protocol.oid));assert.notEqual(b.sensor.endstop.oid,b.verification.protocol.oid);
 assert.equal(b.output.pwm.cycleTicks,20000);assert.equal(b.output.pwm.maximumDuration,0);assert.equal(b.output.pwm.startValue,0);assert.equal(b.output.pwm.shutdownValue,0);
 assert.deepEqual(plan.configurations.map(c=>c.plan.reservedMoves),[0,1]);assert.deepEqual(plan.configurations.map(c=>c.plan.oidCount),[3,2]);assert(plan.configurations[0].plan.commands!.includes(b.verification.protocol.commands[0]));assert(plan.configurations[1].plan.init!.includes(b.output.pwm.init[0]));
});
test('physical alias conflicts and missing sensor ownership fail atomically',()=>{
 const f=hardwareFixture();assert.throws(()=>compileConfiguredHardware(reader({control_pin:'PA0_ALIAS'}),f.group,hardwareClocks(),layout),/used multiple times|exclusive/);
 assert.throws(()=>compileConfiguredHardware(reader(),f.group,hardwareClocks(),{...layout,homing:[]}),/sensor owner/);
 const good=compileConfiguredHardware(reader(),f.group,hardwareClocks(),layout),again=compileConfiguredHardware(reader(),f.group,hardwareClocks(),layout);assert.deepEqual(good.configurations.map(c=>c.plan),again.configurations.map(c=>c.plan));
});
test('compiled BLTouch resources configure on two native MCU sessions without motion',async()=>{
 const f=await hardwareStartupFixture();try{const plan=compileConfiguredHardware(reader(),f.group,f.clocks,layout);for(const c of plan.configurations)await c.session.configure(c.plan,f.signal);assert(f.firmware.every(m=>m.motion.length===0));assert(f.firmware[0].outputs.some(o=>o.name==='config_endstop'));assert.equal(f.firmware[0].outputs.filter(o=>o.name==='config_trsync').length,2);assert(f.firmware[1].outputs.some(o=>o.name==='set_digital_out_pwm_cycle'&&o.parameters.cycle_ticks===20000));assert(f.firmware[1].outputs.some(o=>o.name==='queue_digital_out'&&o.parameters.on_ticks===0));}finally{await f.close();}
});
test('startup initializes the compiled BLTouch before publishing ready',async()=>{
 const f=await hardwareStartupFixture();try{const decoder=new FrameDecoder(),fw=f.firmware[0];fw.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const c of fw.dictionary.parseFrame(frame))if(c.name==='endstop_home'&&Number(c.parameters.sample_count)){const p=c.parameters;fw.setTriggerReason(1,Number(p.trsync_oid));fw.setEndstopState({homing:0,pin_value:Number(p.pin_value),next_clock:(Number(p.clock)+Number(p.rest_ticks))>>>0},Number(p.oid));}});
 const owner=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{heaterGcodeIds:{},beforeTarget(){}},f.signal);assert.equal(owner.status.state,'ready');assert.equal(owner.bltouch!.status.device.phase,'idle');assert(f.firmware.every(m=>m.motion.length===0));await owner.close();assert.deepEqual(f.stops,[1,1]);}finally{await f.close();}
});
