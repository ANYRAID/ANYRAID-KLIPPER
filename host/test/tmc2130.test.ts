import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {planTmc2130} from '../src/drivers/tmc2130.ts';
import {initializeTmc220x} from '../src/drivers/tmc220x.ts';
import {Tmc220xCurrent} from '../src/drivers/tmc220x-current.ts';
import {TmcSpiChain} from '../src/drivers/tmc-spi.ts';
const reference=JSON.parse(readFileSync(new URL('../contracts/tmc2130-reference.json',import.meta.url),'utf8'));
const reader=(driver:Record<string,string>,stepper:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{'tmc2130 stepper_x':driver,stepper_x:stepper},[]),null);
test('TMC2130 register ordering, signed SGT, wave tables and quantization match 256 original constructors',()=>{
 for(const row of reference.rows){const plan=planTmc2130(reader(row.driver,row.stepper),'tmc2130 stepper_x');assert.deepEqual(plan.registers,row.registers);assert.deepEqual(plan.current,row.current);assert(Object.isFrozen(plan.registers));}
});
test('TMC2130 validates signed and full-width fields and preserves physical speed thresholds across microsteps',()=>{
 const driver={run_current:'.8',stealthchop_threshold:'20',coolstep_threshold:'10',high_velocity_threshold:'100'},stepper={rotation_distance:'40',microsteps:'16'};
 for(const change of [{driver_sgt:'-65'},{driver_sgt:'64'},{driver_mslut0:'4294967296'},{driver_start_sin90:'256'},{run_current:'0'}] as Record<string,string>[])assert.throws(()=>planTmc2130(reader({...driver,...change},stepper),'tmc2130 stepper_x'));
 const values=[];for(let i=0;i<=8;i++)values.push(planTmc2130(reader(driver,{...stepper,microsteps:String(2**i)}),'tmc2130 stepper_x').registers.filter(r=>['TPWMTHRS','TCOOLTHRS','THIGH'].includes(r.name)));
 for(const value of values)assert.deepEqual(value,values[0]);assert.throws(()=>planTmc2130(reader(driver,{...stepper,microsteps:'3'}),'tmc2130 stepper_x'));
});
test('SPI initialization verifies every register before current owner can publish a change',async()=>{
 const row=reference.rows[42],plan=planTmc2130(reader(row.driver,row.stepper),'tmc2130 stepper_x'),writes:number[][]=[],signal=new AbortController().signal;
 const device=new TmcSpiChain({async transfer(frame){const b=Buffer.from(frame),value=b.readUInt32BE(1);writes.push([b[0]&127,value]);b[0]=0;return b;}}).register();
 await initializeTmc220x(device,plan,signal);assert.deepEqual(writes,plan.registers.map(r=>[r.address,r.value]));
 const owner=new Tmc220xCurrent(device,plan,signal,()=>assert.fail('fault'));await owner.set({run:1.5,hold:.3},signal);assert(owner.current.runCurrent>1.4);assert.equal(owner.revision,1);
 const chop=writes.filter(r=>r[0]===0x6c);assert.equal(chop.at(-1)![1]&~(1<<17),chop[0][1]&~(1<<17));
});
test('adjacent Float64 threshold rounding and 20-bit clamping match original constructor',()=>{
 for(const row of reference.thresholdBoundaries)assert.deepEqual(planTmc2130(reader(row.driver,row.stepper),'tmc2130 stepper_x').registers.filter(r=>['TPWMTHRS','TCOOLTHRS','THIGH'].includes(r.name)),row.registers);
});
