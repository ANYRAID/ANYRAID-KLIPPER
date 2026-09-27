import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeLinearFixture} from './helpers/native-linear-port.ts';
import {TmcSensorlessMode} from '../src/drivers/tmc-sensorless.ts';
const signal=()=>new AbortController().signal;
for(const failure of ['entry','cancel'])test(`sensorless G28 ${failure} retires motion without restoring a potentially moving driver`,async()=>{
 let writes=0;const abort=new AbortController();
 const mode=new TmcSensorlessMode({async write(){writes++;if(failure==='entry')throw new Error('mode write lost');}},'tmc2209',[{name:'GCONF',address:0,value:4},{name:'TPWMTHRS',address:19,value:123},{name:'TCOOLTHRS',address:20,value:0}],undefined,signal(),()=>{});
 const t=await nativeLinearFixture(0,()=>false,false,undefined,false,false,false,undefined,mode);
 const timer=setInterval(()=>{if(failure==='cancel'&&t.f.fw.outputs.some(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0))abort.abort(new Error('cancel armed homing'));},1);
 try{
  await assert.rejects(t.command.home([0],abort.signal),failure==='entry'?/mode write lost/:/cancel armed homing/);
  assert.equal(t.port.status.failed,true);assert.equal(t.kinematics.status.homedAxes,'');assert.equal(writes,failure==='entry'?1:3);assert.equal(t.f.stops,1);
  if(failure==='entry')assert(!t.f.fw.outputs.some(o=>o.name==='endstop_home'&&Number(o.parameters.sample_count)>0));
 }finally{clearInterval(timer);await t.close();}
});
