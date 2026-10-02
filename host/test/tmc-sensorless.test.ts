import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {planTmcSensorless,TmcSensorlessMode,type SensorlessRegister,type SensorlessPlan} from '../src/drivers/tmc-sensorless.ts';
const reference:{rows:{model:string;diag:0|1|null;registers:SensorlessRegister[];expected:SensorlessPlan}[]}=JSON.parse(readFileSync(new URL('../contracts/tmc-sensorless-reference.json',import.meta.url),'utf8'));
const signal=()=>new AbortController().signal;
test('640 sensorless transitions match original Python field values and register order',async()=>{
 for(const row of reference.rows){
  assert.deepEqual(planTmcSensorless(row.model,row.registers,row.diag??undefined),row.expected);
  const writes:number[][]=[],mode=new TmcSensorlessMode({async write(r,v){writes.push([r,v]);}},row.model,row.registers,row.diag??undefined,signal(),()=>assert.fail('fault'));
  for(let pass=0;pass<2;pass++){writes.length=0;await mode.enter(signal());assert.equal(mode.state,'active');await mode.restore(signal());assert.equal(mode.state,'idle');assert.deepEqual(writes,[...row.expected.enter,...row.expected.restore].map(r=>[r.address,r.value]));}
 }
});
test('ambiguous writes and cancellation at every transition boundary retire ownership',async()=>{
 for(const row of [reference.rows[0],reference.rows[128],reference.rows[384]]){
  const sequence=[...row.expected.enter,...row.expected.restore];
  for(const cancel of [false,true])for(let failAt=0;failAt<sequence.length;failAt++){
   const abort=new AbortController(),faults:unknown[]=[];let writes=0;
   const mode=new TmcSensorlessMode({async write(){if(writes++===failAt){if(cancel)abort.abort(new Error('cancelled'));else throw new Error('unacknowledged');}}},row.model,row.registers,row.diag??undefined,signal(),e=>faults.push(e));
   await assert.rejects(async()=>{await mode.enter(abort.signal);await mode.restore(abort.signal);},/cancelled|unacknowledged/);
   assert.equal(mode.state,'failed');assert.equal(writes,failAt+1);assert.equal(faults.length,1);
   await assert.rejects(mode.enter(signal()),/unavailable/);await assert.rejects(mode.restore(signal()),/unavailable/);assert.equal(writes,failAt+1);
  }
 }
});
test('entry and restoration are exclusive and publish state only after final acknowledgement',async()=>{
 const row=reference.rows[0],pending=Promise.withResolvers<void>();let writes=0;
 const mode=new TmcSensorlessMode({async write(){writes++;await pending.promise;}},row.model,row.registers,undefined,signal(),()=>assert.fail('fault'));
 const entering=mode.enter(signal());assert.equal(mode.state,'entering');await assert.rejects(mode.enter(signal()),/unavailable/);await assert.rejects(mode.restore(signal()),/unavailable/);assert.equal(writes,1);pending.resolve();await entering;assert.equal(mode.state,'active');
 const restoring=mode.restore(signal());assert.equal(mode.state,'restoring');await assert.rejects(mode.enter(signal()),/unavailable/);await assert.rejects(mode.restore(signal()),/unavailable/);await restoring;assert.equal(mode.state,'idle');
});
test('pre-cancelled entry does no I/O; pre-cancelled restore retires active hardware',async()=>{
 const row=reference.rows[0],abort=new AbortController(),faults:unknown[]=[];let writes=0;
 const mode=new TmcSensorlessMode({async write(){writes++;}},row.model,row.registers,undefined,signal(),e=>faults.push(e));abort.abort(new Error('cancelled'));
 await assert.rejects(mode.enter(abort.signal),/cancelled/);assert.equal(writes,0);assert.equal(mode.state,'idle');assert.equal(faults.length,0);
 await mode.enter(signal());const count=writes;await assert.rejects(mode.restore(abort.signal),/cancelled/);assert.equal(writes,count);assert.equal(mode.state,'failed');assert.equal(faults.length,1);
});
test('invalid model, DIAG and incomplete or corrupt register images fail before I/O',()=>{
 const row=reference.rows[0];assert.throws(()=>planTmcSensorless('tmc2208',row.registers));assert.throws(()=>planTmcSensorless('tmc2209',row.registers,0));assert.throws(()=>planTmcSensorless('tmc2130',row.registers));
 for(const registers of [[],[...row.registers,row.registers[0]],row.registers.map(r=>({...r,value:-1})),row.registers.map(r=>({...r,address:99}))])assert.throws(()=>planTmcSensorless('tmc2209',registers));
});

test('TMC2240 SG4 selects stealthchop and restores thresholds while SG2 selects spreadcycle',()=>{
 for(const diag of [0,1] as const)for(const sg4 of [0,1,255]){
  const registers=[{name:'GCONF',address:0,value:0x8000000c},{name:'TPWMTHRS',address:0x13,value:123},{name:'TCOOLTHRS',address:0x14,value:0},{name:'THIGH',address:0x15,value:456},{name:'SG4_THRS',address:0x74,value:512|sg4}];
  const p=planTmcSensorless('tmc2240',registers,diag),mask=1<<(diag===0?7:8);
  assert.deepEqual(p.enter,[{name:'GCONF',address:0,value:(0x80000008|mask|(sg4?4:0))>>>0},...sg4?[{name:'TPWMTHRS',address:0x13,value:0}]:[],{name:'TCOOLTHRS',address:0x14,value:0xfffff},{name:'THIGH',address:0x15,value:0}]);
  assert.deepEqual(p.restore,p.enter.map(r=>registers.find(o=>o.name===r.name)));
 }
});
