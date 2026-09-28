import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from './helpers/configured-hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
test('configured combined sensors publish chained values and stop every MCU on source disagreement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'combined-hardware-')),a=join(dir,'a'),b=join(dir,'b'),f=await hardwareStartupFixture(false,false,true);let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const until=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  await writeFile(a,'20000');await writeFile(b,'22000');const sections={'temperature_sensor a':{sensor_type:'temperature_host',sensor_path:a},'temperature_sensor b':{sensor_type:'temperature_host',sensor_path:b},'temperature_sensor aggregate':{sensor_type:'temperature_combined',sensor_list:'temperature_combined mean, temperature_sensor a',combination_method:'max',maximum_deviation:'5',gcode_id:'C'},'temperature_sensor mean':{sensor_type:'temperature_combined',sensor_list:'temperature_sensor a, temperature_sensor b',combination_method:'mean',maximum_deviation:'5'}};
  const reader=new ConfigurationReader(new ConfigurationSource('/combined.cfg',{...hardwareReader().source.original,...sections},[]),null);
  owner=await startConfiguredHardware(reader,f.group,f.clocks,{...hardwareLayout,sensors:Object.keys(sections).map(section=>({section}))},{beforeTarget(){}},f.signal);
  assert.deepEqual(owner.combinedSensors.map(s=>s.section),['temperature_sensor mean','temperature_sensor aggregate']);
  await until(()=>!owner!.combinedSensors[1].state.getTemperature().stale);assert.equal(owner.combinedSensors[1].state.getTemperature().temperature,21);assert.equal(owner.heaters.report(),'C:21.0 /0.0');
  await writeFile(b,'40000');await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert(owner.combinedSensors.every(s=>s.state.getTemperature().stale));
 }finally{await owner?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
