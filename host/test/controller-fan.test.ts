import test from 'node:test';
import assert from 'node:assert/strict';
import {ControllerFanState,readControllerFanPolicy} from '../src/thermal/controller-fan.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const policy=(options:Record<string,string>={})=>readControllerFanPolicy(new ConfigurationReader(new ConfigurationSource('/controller.cfg',{'controller_fan board':options},[]),null),'controller_fan board',['extruder'],['stepper_x','extruder']);
test('controller fan validates named heaters and steppers with explicit empty selections',()=>{
 assert.deepEqual(policy(),{heaters:['extruder'],steppers:['stepper_x','extruder'],speed:1,idleSpeed:1,idleTimeout:30});assert.deepEqual(policy({heater:'',stepper:''}).heaters,[]);
 for(const options of [{heater:'missing'},{stepper:'x'},{stepper:'stepper_x,stepper_x'},{idle_timeout:'-1'},{idle_timeout:'.5'},{idle_speed:'2'}] as Record<string,string>[]) assert.throws(()=>policy(options));
});
test('elapsed idle timeout does not advance faster during kick-settling callbacks',()=>{
 const s=new ControllerFanState(policy({fan_speed:'.8',idle_speed:'.3',idle_timeout:'2'}));
 assert.equal(s.speed(0,false),0);assert.equal(s.speed(1,true),.8);assert.equal(s.speed(2,false),.3);
 for(const t of [2.01,2.1,2.5,3,3.999])assert.equal(s.speed(t,false),.3);assert.equal(s.speed(4,false),0);
 assert.equal(s.speed(5,true),.8);assert.equal(s.speed(6,false),.3);assert.throws(()=>s.speed(5,false),/clock/);
 const immediate=new ControllerFanState(policy({idle_timeout:'0'}));assert.equal(immediate.speed(0,true),1);assert.equal(immediate.speed(1,false),0);
});
