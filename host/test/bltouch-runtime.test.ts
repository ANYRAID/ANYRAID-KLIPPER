import test from 'node:test';
import assert from 'node:assert/strict';
import {attachConfiguredBLTouch} from '../src/runtime/bltouch.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {FrameDecoder} from '../src/protocol/codec.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
async function fixture(){
 const f=await hardwareStartupFixture(),reader=new ConfigurationReader(new ConfigurationSource('/bltouch.cfg',{bltouch:{sensor_pin:'^PA0',control_pin:'aux:PA1',z_offset:'1.5'}},[]),null),plan=compileConfiguredHardware(reader,f.group,f.clocks,{steppers:[],homing:[{section:'bltouch',mcus:['mcu','aux']}],fans:[],heaters:[]});
 for(const c of plan.configurations)await c.session.configure(c.plan,f.signal);
 const decoder=new FrameDecoder(),sensor=f.firmware[0];let checks=0;
 sensor.peer.on('data',chunk=>{for(const frame of decoder.push(typeof chunk==='string'?Buffer.from(chunk):chunk))for(const command of sensor.dictionary.parseFrame(frame))if(command.name==='endstop_home'&&Number(command.parameters.sample_count)){
  const p=command.parameters;checks++;sensor.setTriggerReason(1,Number(p.trsync_oid));sensor.setEndstopState({homing:0,pin_value:Number(p.pin_value),next_clock:(Number(p.clock)+Number(p.rest_ticks))>>>0},Number(p.oid));
 }});
 return {...f,plan,get checks(){return checks;}};
}
test('compiled split-MCU BLTouch starts generation output, verifies sensors and stows before returning idle',async t=>{
 const f=await fixture();try{const owner=attachConfiguredBLTouch(f.group,f.plan);assert.throws(()=>attachConfiguredBLTouch(f.group,f.plan),/already owned/);const start=performance.now();await owner.start(f.signal);assert.equal(owner.status.device.phase,'idle');assert.equal(owner.status.output.phase,'ready');assert.equal(f.checks,1);
  await owner.device.session(sample=>sample(async(_s,trigger)=>{assert(owner.status.device.deployed);await trigger();return 1;}),f.signal);
  assert.equal(owner.status.device.phase,'idle');assert.equal(owner.status.device.deployed,false);assert.equal(f.checks,3);assert(f.firmware.every(m=>m.motion.length===0));const control=f.firmware[1].outputs;assert(control.some(o=>o.name==='reset_digital_out_generation'));assert(control.some(o=>o.name==='queue_digital_out_generation'&&o.parameters.on_ticks===650));assert.equal(control.filter(o=>o.name==='queue_digital_out_generation').at(-1)!.parameters.on_ticks,0);await owner.close(Error('test closed'));assert.deepEqual(f.stops,[1,1]);assert.equal(owner.status.device.phase,'failed');t.diagnostic(JSON.stringify({splitMCULifecycleMs:performance.now()-start,checks:f.checks,motion:false,generationOutput:true}));
 }finally{await f.close();}
});
test('cancelled startup stops both MCUs and cannot publish ready from late verification',async()=>{
 const f=await fixture();try{const owner=attachConfiguredBLTouch(f.group,f.plan),abort=new AbortController();const pending=owner.start(abort.signal),rejected=assert.rejects(pending,/cancel startup/);abort.abort(Error('cancel startup'));await rejected;assert.deepEqual(f.stops,[1,1]);assert.equal(owner.status.device.phase,'failed');await assert.rejects(owner.start(f.signal),/already started/);assert(f.firmware.every(m=>m.motion.length===0));}finally{await f.close();}
});
