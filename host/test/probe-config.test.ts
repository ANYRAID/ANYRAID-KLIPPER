import test from 'node:test';
import assert from 'node:assert/strict';
import {readProbeConfiguration} from '../src/config/probe.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const reader=(probe?:Record<string,string>)=>new ConfigurationReader(new ConfigurationSource('/probe.cfg',probe?{probe}:{},[]),null);
test('probe defaults and offset signs are preserved without precision rounding',()=>{
 assert.equal(readProbeConfiguration(reader()),undefined);
 const c=readProbeConfiguration(reader({z_offset:'1.123456789',x_offset:'-20',y_offset:'3.5',speed:'7'}))!;
 assert.deepEqual(c.offsets,[-20,3.5,1.123456789]);assert.equal(c.speed,7);assert.deepEqual(c.sampling,{samples:1,retractDistance:2,liftSpeed:7,tolerance:.1,retries:0,result:'average'});
 assert(Object.isFrozen(c)&&Object.isFrozen(c.offsets)&&Object.isFrozen(c.sampling));
});
test('sampling overrides are typed and bounded',()=>{
 const c=readProbeConfiguration(reader({z_offset:'0',samples:'5',samples_result:'median',samples_tolerance:'.02',samples_tolerance_retries:'3',sample_retract_dist:'1',lift_speed:'8'}))!;assert.equal(c.sampling.samples,5);assert.equal(c.sampling.result,'median');assert.equal(c.sampling.retries,3);
 for(const values of [{},{z_offset:'NaN'},{z_offset:'0',samples:'1001'},{z_offset:'0',samples_result:'mode'},{z_offset:'0',sample_retract_dist:'0'},{z_offset:'0',activate_gcode:'M400'}] as Record<string,string>[])assert.throws(()=>readProbeConfiguration(reader(values)));
});
