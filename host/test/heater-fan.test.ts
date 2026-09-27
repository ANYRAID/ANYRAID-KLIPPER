import test from 'node:test';
import assert from 'node:assert/strict';
import {readHeaterFanPolicy,heaterFanSpeed} from '../src/thermal/heater-fan.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const policy=(options:Record<string,string>={})=>readHeaterFanPolicy(new ConfigurationReader(new ConfigurationSource('/fan.cfg',{'heater_fan hotend':options},[]),null),'heater_fan hotend',['extruder','heater_generic chamber']);
test('thermal policy validates references and uses full precision threshold',()=>{
 assert.deepEqual(policy(),{heaters:['extruder'],threshold:50,speed:1});
 for(const heater of ['',',','unknown','extruder,extruder'])assert.throws(()=>policy({heater}));
 for(const fan_speed of ['-1','2','nan'])assert.throws(()=>policy({fan_speed}));
 const p=policy({heater:'extruder, chamber',fan_speed:'.75',heater_temp:'50.0000000001'});
 assert.equal(heaterFanSpeed(p,()=>({temperature:50.0000000001,target:0,stale:false})),0);
 assert.equal(heaterFanSpeed(p,n=>({temperature:n==='chamber'?50.0000000002:20,target:0,stale:false})),.75);
});
test('target and stale or faulted readings keep cooling requested after heating stops',()=>{
 const p=policy();
 for(const state of [{temperature:20,target:200,stale:false},{temperature:51,target:0,stale:false},{temperature:0,target:0,stale:true},{temperature:20,target:0,stale:false,fault:'sensor lost'}])assert.equal(heaterFanSpeed(p,()=>state),1);
 assert.equal(heaterFanSpeed(p,()=>({temperature:50,target:0,stale:false})),0);
 assert.throws(()=>heaterFanSpeed(p,()=>({temperature:NaN,target:0,stale:false})),/Invalid/);
});
