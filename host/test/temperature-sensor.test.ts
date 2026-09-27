import test from 'node:test';
import assert from 'node:assert/strict';
import {TemperatureSensorState} from '../src/thermal/temperature-sensor.ts';
import {compileConfiguredAnalogSensors} from '../src/config/analog-sensor.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {stepperBatchFixture} from './helpers/configured-steppers.ts';
import {heaterClocks} from './helpers/configured-heater.ts';
import {mcuOids} from '../src/protocol/mcu-oids.ts';
const reader=(values:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/sensor.cfg',{'temperature_sensor chamber':{sensor_type:'Generic 3950',sensor_pin:'PA0',...values}},[]),null);
test('sensor listeners preserve sample precision, detach and propagate control failures',()=>{
 const state=new TemperatureSensorState(),samples:number[][]=[];
 const detach=state.subscribeSample((time,temp)=>samples.push([time,temp]));state.sample(1.123,25.123456789);assert.deepEqual(samples,[[1.123,25.123456789]]);
 detach();state.sample(2,30);assert.equal(samples.length,1);
 state.subscribeSample(()=>{throw new Error('output owner failed');});assert.throws(()=>state.sample(3,40),/owner failed/);assert.equal(state.getTemperature().temperature,30);
 state.shutdown('closed');assert.throws(()=>state.subscribeSample(()=>{}),/stopped/);
});
test('generic sensor preserves original zero, negative extrema and Python display rounding',()=>{
 const s=new TemperatureSensorState();assert.deepEqual(s.objectStatus,{temperature:0,measured_min_temp:99999999,measured_max_temp:0});assert(s.getTemperature().stale);
 s.sample(1,0);assert.equal(s.objectStatus.measured_min_temp,99999999);assert(!s.getTemperature().stale);
 s.sample(2,-2.675);assert.deepEqual(s.objectStatus,{temperature:-2.67,measured_min_temp:-2.67,measured_max_temp:0});
 s.sample(3,2.675);assert.equal(s.objectStatus.temperature,2.67);assert.equal(s.getTemperature().temperature,2.675);assert.equal(s.getTemperature().target,0);
 s.shutdown('fault');assert(s.getTemperature().stale);assert.throws(()=>s.sample(4,40),/stopped/);
});
test('independent ADC has original default limits, no output and exclusive pin/OID ownership',()=>{
 const f=stepperBatchFixture(),[p]=compileConfiguredAnalogSensors(reader(),f.pins,f.mcus,heaterClocks(),[{section:'temperature_sensor chamber'}]);
 assert.equal(p.minimum,-273.15);assert.equal(p.maximum,99999999.9);assert.equal(p.adc.oid,0);assert.equal(p.adc.maximumSum,32760);assert(p.adc.commands.every(c=>!c.includes('out')));assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,1);
 assert.throws(()=>compileConfiguredAnalogSensors(reader(),f.pins,f.mcus,heaterClocks(),[{section:'temperature_sensor chamber'}]),/used multiple times|owner/);
});
test('sensor planning rejects invalid converter, range, pin or G-code id without claims',()=>{
 for(const values of [{sensor_type:'unknown'},{min_temp:'-274'},{min_temp:'100',max_temp:'90'},{sensor_pin:'!PA0'},{gcode_id:'bad id'}] as Record<string,string>[]){
  const f=stepperBatchFixture();assert.throws(()=>compileConfiguredAnalogSensors(reader(values),f.pins,f.mcus,heaterClocks(),[{section:'temperature_sensor chamber'}]));assert.equal(f.pins.claimedPins.length,0);assert.equal(mcuOids(f.pins).snapshot('mcu').oidCount,0);
 }
});
test('generic sensor statistics exactly match fixed original Python reference',async()=>{
 const {readFileSync}=await import('node:fs'),reference=JSON.parse(readFileSync(new URL('../contracts/temperature-sensor-reference.json',import.meta.url),'utf8')),sensor=new TemperatureSensorState();
 for(const [i,row] of reference.rows.entries()){sensor.sample(i,row.input);assert.deepEqual(sensor.objectStatus,row.status);assert.equal(sensor.getTemperature().temperature,row.input);}
});
