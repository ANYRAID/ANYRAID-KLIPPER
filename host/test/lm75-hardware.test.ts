import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/lm75.cfg',s,[]),null);
const source={sensor_type:'LM75',i2c_mcu:'aux',i2c_bus:'i2c1',min_temp:'-55',max_temp:'100'};
for(const mode of ['sensor','fan','heater'])test(`configured LM75 ${mode} publishes temperature without humidity and NACK fault stops both MCUs`,async()=>{
 let temperature=mode==='sensor'?-.5:25,fault=false;
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_data,n)=>{const raw=(Math.round(temperature*2)&511)<<7;return {data:n===1?Uint8Array.of(0):Uint8Array.of(raw>>>8,raw&255),status:fault?'NACK':'SUCCESS'};});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const section=mode==='heater'?'heater_generic chamber':`temperature_${mode} chamber`,aggregate='temperature_sensor aggregate';
 const sections:Record<string,Record<string,string>>={[section]:{...source,...mode==='sensor'?{gcode_id:'C'}:mode==='fan'?{pin:'PA4',control:'watermark',kick_start_time:'0'}:{heater_pin:'PA4',control:'watermark',min_extrude_temp:'0'}}};
 if(mode==='sensor')sections[aggregate]={sensor_type:'temperature_combined',sensor_list:section,combination_method:'mean',maximum_deviation:'1'};
 const until=async(check:()=>boolean)=>{const end=performance.now()+3000;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader(sections),f.group,f.clocks,{steppers:[],homing:[],fans:mode==='fan'?[{section,minimumScheduleTime:.02}]:[],heaters:mode==='heater'?[{section}]:[],sensors:mode==='heater'?[]:Object.keys(sections).map(section=>({section}))},{beforeTarget(){}},f.signal);
  const sensor=owner.i2cSensors[0];assert.equal(sensor.getTemperature().temperature,temperature);assert.equal(sensor.getTemperature().humidity,undefined);assert.equal(sensor.sensorStatus.humidity,undefined);assert.equal(sensor.statusName,'lm75 chamber');assert.equal(owner.plan.i2cSensors[0].address,72);assert.equal(owner.plan.i2cSensors[0].reportTime,.8);
  if(mode==='sensor'){await until(()=>!owner!.combinedSensors[0].getTemperature().stale);assert.equal(owner.combinedSensors[0].getTemperature().humidity,undefined);}
  if(mode==='fan'){await until(()=>owner!.fans[0].runtime.status.speed===0);temperature=60;await until(()=>owner!.fans[0].runtime.status.speed===1);}
  if(mode==='heater'){await owner.heaters.setTarget('chamber',40,f.signal);await until(()=>owner!.thermal[0].runtime.objectStatus.power===1);temperature=60;await until(()=>owner!.thermal[0].runtime.objectStatus.power===0);}
  fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(sensor.getTemperature().stale,true);assert.match(String(owner.status.fault),/I2C|NACK/);
 }finally{await owner?.close();await f.close();}
});
test('mixed AHT and LM75 reserve one bus but reject shared addresses across models',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_data,n)=>({data:Buffer.alloc(n)}));
 try{const a='temperature_sensor a',b='temperature_sensor b',sections={[a]:source,[b]:{...source,sensor_type:'AHT2X'}},layout={steppers:[],homing:[],fans:[],heaters:[],sensors:[{section:a},{section:b}]};
  assert.deepEqual(compileConfiguredHardware(reader(sections),f.group,f.clocks,layout).i2cSensors.map(p=>p.address),[72,56]);
  assert.throws(()=>compileConfiguredHardware(reader({...sections,[b]:{...sections[b],i2c_address:'72'}}),f.group,f.clocks,layout),/Duplicate I2C/);assert.equal(f.firmware.flatMap(f=>f.outputs).length,0);
 }finally{await f.close();}
});
