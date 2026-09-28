import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {hardwareReader,hardwareLayout} from './helpers/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {readTemperatureFan} from '../src/config/temperature-fan.ts';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const section='temperature_fan chamber';
const reader=(overrides:Record<string,string>={})=>new ConfigurationReader(new ConfigurationSource('/fan.cfg',{...hardwareReader().source.original,[section]:{pin:'PA4',sensor_pin:'aux:PA4',sensor_type:'Generic 3950',control:'watermark',min_temp:'0',max_temp:'100',kick_start_time:'0',gcode_id:'F',...overrides}},[]),null);
const layout={...hardwareLayout,fans:[...hardwareLayout.fans,{section,minimumScheduleTime:.02}],sensors:[{section}]};
const until=async(check:()=>boolean)=>{const end=performance.now()+4000;while(!check()){assert(performance.now()<end,'temperature fan observation timeout');await delay(5);}};
test('temperature fan policy validates required range, control and speed limits before IO',()=>{
 const p=readTemperatureFan(reader(),section);assert.equal(p.settings.target,40);assert.equal(p.reportDelay,.3);
 assert.equal(readTemperatureFan(reader({sensor_type:'temperature_host'}),section).reportDelay,1);
 for(const options of [{min_speed:'.9',max_speed:'.5'},{control:'unknown'},{control:'pid'},{max_speed:'0'},{max_temp:'-1'},{target_temp:'101'}] as Record<string,string>[])assert.throws(()=>readTemperatureFan(reader(options),section));
});
test('host temperature fan maps host readings to MCU print time and stops on source failure',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'temperature-fan-')),path=join(dir,'temperature'),f=await hardwareStartupFixture(false,false,true);
 try{
  await writeFile(path,'25000\n');const owner=await startConfiguredHardware(reader({sensor_type:'temperature_host',sensor_path:path}),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);
  const fan=owner.fans.find(f=>f.section===section)!.runtime;await until(()=>fan.status.speed===0);
  assert.equal(owner.temperatureFans[0].control.reportDelay,1);assert.equal(owner.temperatureFans[0].state.getTemperature().temperature,25);
  await writeFile(path,'60000\n');await until(()=>fan.status.speed===1);
  await writeFile(path,'invalid\n');await until(()=>owner.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);
 }finally{await f.close();await rm(dir,{recursive:true,force:true});}
});
test('configured cross-MCU temperature fan drives PWM from ADC and stops all devices on invalid sample',async()=>{
 const f=await hardwareStartupFixture(false,false,true);let interval:ReturnType<typeof setInterval>|undefined;
 try{
  const owner=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);
  const p=owner.plan.sensors[0],session=f.group.session(p.mcu),fan=owner.temperatureFans[0],output=owner.fans.find(f=>f.section===section)!.runtime;
  assert.equal(owner.plan.fans.find(f=>f.section===section)!.config.shutdownPower,1);
  let temperature=25;
  const emit=()=>{const raw=Math.round(p.converter.adc(temperature)*p.adc.maximumSum);f.firmware[1].emit('analog_in_state',{oid:p.adc.oid,next_clock:Number(BigInt.asUintN(32,session.clock.sync.getClock(serialClock.now())+292000n)),values:Buffer.from([raw&255,raw>>8])});};
  emit();interval=setInterval(emit,100);await until(()=>output.status.speed===0);
  assert.equal(owner.heaters.report(),'F:25.0 /40.0');assert.equal(fan.state.getTemperature().stale,false);
  temperature=60;await until(()=>output.status.speed===1);assert(fan.control.state.temperature>59);
  fan.control.configure({maximumSpeed:.4});await until(()=>output.status.speed===.4);
  fan.control.configure({target:0});await until(()=>output.status.speed===0);
  temperature=120;await until(()=>owner.status.state!=='ready');clearInterval(interval);interval=undefined;await owner.close();
  assert.deepEqual(f.stops,[1,1]);assert.equal(output.status.phase,'stopped');
 }finally{if(interval)clearInterval(interval);await f.close();}
});
test('combined temperature fan maps aggregate samples to output clock and restores shutdown cooling on disagreement',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'combined-fan-')),a=join(dir,'a'),b=join(dir,'b'),f=await hardwareStartupFixture(false,false,true);let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 try{
  await writeFile(a,'25000');await writeFile(b,'25000');const base=reader({sensor_type:'temperature_combined',sensor_list:'temperature_sensor a, temperature_sensor b',combination_method:'mean',maximum_deviation:'5'});
  const r=new ConfigurationReader(new ConfigurationSource('/combined-fan.cfg',{...base.source.original,'temperature_sensor a':{sensor_type:'temperature_host',sensor_path:a},'temperature_sensor b':{sensor_type:'temperature_host',sensor_path:b}},[]),null);
  owner=await startConfiguredHardware(r,f.group,f.clocks,{...layout,sensors:[{section:'temperature_sensor a'},{section:'temperature_sensor b'},{section}]},{beforeTarget(){}},f.signal);
  const fan=owner.temperatureFans[0],output=owner.fans.find(f=>f.section===section)!.runtime;
  assert.equal(fan.control.reportDelay,.3);await until(()=>output.status.speed===0);assert.equal(owner.heaters.report(),'F:25.0 /40.0');
  // Rise one source at a time within the configured agreement bound so normal
  // asynchronous sampling does not create an artificial fault during warmup.
  for(const temperature of [30,35,40,45]){await writeFile(a,String(temperature*1000));await writeFile(b,String(temperature*1000));await until(()=>fan.state.getTemperature().temperature===temperature);}
  await until(()=>output.status.speed===1);assert.equal(fan.state.getTemperature().temperature,45);
  await writeFile(b,'70000');await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(output.status.phase,'stopped');assert(owner.combinedSensors[0].state.getTemperature().stale);
  assert.equal(owner.plan.fans.find(p=>p.section===section)!.config.shutdownPower,1);
 }finally{await owner?.close();await f.close();await rm(dir,{recursive:true,force:true});}
});
