import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout,hardwareFixture,hardwareClocks} from './helpers/configured-hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const reader=(a:string,b:string,output='aux:PA1')=>new ConfigurationReader(new ConfigurationSource('/combined-heater.cfg',{...hardwareReader().source.original,extruder:{...hardwareReader().source.original.extruder,heater_pin:output,sensor_type:'temperature_combined',sensor_list:'temperature_sensor a, temperature_sensor b',combination_method:'mean',maximum_deviation:'5'},'temperature_sensor a':{sensor_type:'temperature_host',sensor_path:a},'temperature_sensor b':{sensor_type:'temperature_host',sensor_path:b}},[]),null);
const layout={...hardwareLayout,sensors:[{section:'temperature_sensor a'},{section:'temperature_sensor b'}]};
for(const output of ['aux:PA1','PA4'])test(`combined heater requires fresh input, drives acknowledged PWM and stops both MCUs: ${output}`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'combined-heater-')),a=join(dir,'a'),b=join(dir,'b'),f=await hardwareStartupFixture(false,false,true);let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const until=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  await writeFile(a,'25000');await writeFile(b,'25000');owner=await startConfiguredHardware(reader(a,b,output),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);
  const heater=owner.thermal[0].runtime,p=owner.plan.combinedHeaters[0],fw=f.firmware[p.output.mcu==='mcu'?0:1],writes=()=>fw.outputs.filter(e=>e.name==='queue_digital_out_generation'&&e.parameters.oid===p.output.pwm.oid&&Number(e.parameters.on_ticks)>0);
  assert.equal(owner.plan.heaters.length,0);assert.equal(owner.heaters.getTemperature('extruder').stale,true);await assert.rejects(heater.setTarget(200,f.signal),/Fresh temperature/);assert.equal(writes().length,0);
  await until(()=>!heater.getTemperature().stale);await owner.heaters.setTarget('extruder',200,f.signal);await until(()=>writes().length>0);assert.equal(heater.getTemperature().target,200);
  await writeFile(b,'70000');await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(heater.getTemperature().target,0);assert.equal(heater.status.outputStopConfirmed,true);const count=writes().length;await delay(50);assert.equal(writes().length,count);await assert.rejects(heater.setTarget(200,f.signal));
 }finally{await owner?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
test('combined heater rejects dependency cycles and occupied output before MCU configuration',()=>{
 const f=hardwareFixture();assert.throws(()=>compileConfiguredHardware(reader('/tmp/a','/tmp/b','PA0'),f.group,hardwareClocks(),layout),/pin|Pin/);
 const r=reader('/tmp/a','/tmp/b'),cycle=new ConfigurationReader(new ConfigurationSource('/cycle.cfg',{...r.source.original,extruder:{...r.source.original.extruder,sensor_list:'extruder'}},[]),null);assert.throws(()=>compileConfiguredHardware(cycle,f.group,hardwareClocks(),layout),/cycle/);
});
