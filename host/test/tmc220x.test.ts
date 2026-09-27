import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc220x,tmc220xCurrent,initializeTmc220x} from '../src/drivers/tmc220x.ts';
import {TmcUartBus,encodeTmcWrite} from '../src/drivers/tmc-uart.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc220x-reference.json',import.meta.url),'utf8'));
const reader=(model:string,driver:Record<string,string>,stepper:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{[model+' stepper_x']:driver,stepper_x:stepper},[]),null);
test('all startup registers and quantized current match 256 original model constructors',()=>{
 for(const row of reference.rows){const plan=planTmc220x(reader(row.model,row.driver,row.stepper),row.model+' stepper_x');assert.deepEqual(plan.registers,row.registers);assert.deepEqual(plan.current,row.current);assert(Object.isFrozen(plan.registers));}
});
test('current boundaries, invalid resolution, address and fields are rejected before I/O',()=>{
 for(const n of [0,-1,2.001,NaN,Infinity])assert.throws(()=>tmc220xCurrent(n));
 assert.throws(()=>tmc220xCurrent(1,1,Number.MAX_VALUE),/overflow/);
 for(const [model,driver,stepper] of [['tmc2209',{run_current:'1',driver_pwm_lim:'16'},{microsteps:'16',rotation_distance:'40'}],['tmc2208',{run_current:'1',uart_address:'1'},{microsteps:'16',rotation_distance:'40'}],['tmc2209',{run_current:'1'},{microsteps:'3',rotation_distance:'40'}]] as const)assert.throws(()=>planTmc220x(reader(model,driver,stepper),model+' stepper_x'));
});
test('initialization writes every planned register through IFCNT and stops after a failed transaction',async()=>{
 const row=reference.rows[200],plan=planTmc220x(reader(row.model,row.driver,row.stepper),row.model+' stepper_x'),writes:string[]=[];let count=254,fail=false;
 const device=new TmcUartBus({async transfer(_oid,frame,read){if(read)return encodeTmcWrite(255,2,count,true);if(fail)throw new Error('driver lost');writes.push(Buffer.from(frame).toString('hex'));count=(count+1)&255;return Buffer.alloc(0);}}).register(0,0);
 await initializeTmc220x(device,plan,new AbortController().signal);assert.deepEqual(writes,plan.registers.map(r=>encodeTmcWrite(0,r.address,r.value).toString('hex')));
 fail=true;await assert.rejects(initializeTmc220x(device,plan,new AbortController().signal),/driver lost/);assert.equal(writes.length,plan.registers.length);
});
test('adjacent Float64 values around current quantization boundaries preserve original decisions',()=>{
 for(const row of reference.currentBoundaries)assert.deepEqual(tmc220xCurrent(row.run,row.hold,row.resistor),row.expected);
});
