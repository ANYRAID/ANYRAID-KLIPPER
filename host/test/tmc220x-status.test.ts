import test from 'node:test';
import assert from 'node:assert/strict';
import {tmc220xStatusReader} from '../src/drivers/tmc220x-status.ts';
import {planTmc220x} from '../src/drivers/tmc220x.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {NativeObjects} from '../src/moonraker/native-objects.ts';
const plan=planTmc220x(new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{'tmc2209 stepper_x':{run_current:'.8',hold_current:'.4'},stepper_x:{microsteps:'16',rotation_distance:'40'}},[]),null),'tmc2209 stepper_x');
test('cached status preserves unsigned fields, actual quantization, projection and detached snapshots',()=>{
 let state={closed:false,checks:1,drvStatus:0xc01fffff,gstat:0,warnings:0xf01,fault:undefined as unknown};
 const read=tmc220xStatusReader(plan,{get status(){return state;}}),objects=new NativeObjects(new Map([['tmc2209 stepper_x',read]]),()=>1);
 const value=read();assert.equal(value.run_current,plan.current.runCurrent);assert.notEqual(value.run_current,.8);assert.equal(value.hold_current,plan.current.holdCurrent);
 assert.deepEqual(value.drv_status,{otpw:1,ot:1,s2ga:1,s2gb:1,s2vsa:1,s2vsb:1,ola:1,olb:1,t120:1,t143:1,t150:1,t157:1,cs_actual:31,stealth:1,stst:1});
 assert.equal(read().drv_status,value.drv_status);const copy=objects.query({'tmc2209 stepper_x':['drv_status','unsupported']}).status['tmc2209 stepper_x'] as any;copy.drv_status.ot=0;assert.equal(read().drv_status!.ot,1);assert.equal(copy.unsupported,null);
 state={...state,drvStatus:0};assert.deepEqual(read().drv_status,{});assert.equal(value.drv_status!.ot,1);
 state={...state,closed:true,fault:new Error('private transport detail')};assert.equal(read().drv_status,null);assert.deepEqual(read().native_monitor,{active:false,checks:1,fault:true,gstat:0});assert(!JSON.stringify(read()).includes('private'));
});
test('never-started and normally closed monitors do not advertise current driver telemetry',()=>{
 const state={closed:false,checks:0,drvStatus:null,gstat:null,warnings:null,fault:undefined};const read=tmc220xStatusReader(plan,{status:state});assert.equal(read().drv_status,null);assert.equal(read().native_monitor.active,false);state.closed=true;assert.equal(read().native_monitor.fault,false);assert.equal(read().temperature,null);assert.equal(read().mcu_phase_offset,null);
});
