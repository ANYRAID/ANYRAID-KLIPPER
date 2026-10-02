import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc2240} from '../src/drivers/tmc2240.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc2240-plan-reference.json',import.meta.url),'utf8')) as {rows:{driver:Record<string,string>;stepper:Record<string,string>;registers:{name:string;address:number;value:number}[]}[]};
const reader=(driver:Record<string,string>,stepper:Record<string,string>={rotation_distance:'40',microsteps:'16'})=>new ConfigurationReader(new ConfigurationSource('/tmc2240.cfg',{'stepper_x':stepper,'tmc2240 stepper_x':driver},[]),null);
test('310 original TMC2240 startup plans preserve register order, values and threshold boundaries',()=>{
 assert.equal(reference.rows.length,310);for(const row of reference.rows){const plan=planTmc2240(reader(row.driver,row.stepper),'tmc2240 stepper_x');assert.deepEqual(plan.registers,row.registers);assert.equal(plan.model,'tmc2240');assert.equal(plan.microsteps,Number(row.stepper.microsteps));assert(Object.isFrozen(plan.registers));assert(plan.registers.every(Object.isFrozen));}
});
test('TMC2240 signed waveform offset and model-specific fields reject unsupported values',()=>{
 const invalid:Record<string,string>[]=[{driver_offset_sin90:'-129'},{driver_offset_sin90:'128'},{driver_sg4_thrs:'256'},{driver_irundelay:'16'},{driver_slope_control:'4'},{rref:'11999'},{rref:'60001'},{run_current:'0'},{run_current:'3'},{stealthchop_threshold:'-1'}];for(const driver of invalid)assert.throws(()=>planTmc2240(reader({run_current:'.8',...driver}),'tmc2240 stepper_x'));
 assert.throws(()=>planTmc2240(reader({run_current:'.8'},{rotation_distance:'40',microsteps:'3'}),'tmc2240 stepper_x'));
 const a=planTmc2240(reader({run_current:'.8',driver_offset_sin90:'-128'}),'tmc2240 stepper_x');assert.equal(a.registers.find(r=>r.name==='MSLUTSTART')!.value>>>24,128);
});
