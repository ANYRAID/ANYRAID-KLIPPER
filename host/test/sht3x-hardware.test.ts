import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {sht3xCrc} from '../src/thermal/sht3x.ts';
const bytes=(n:number)=>[n>>>8,n&255,sht3xCrc(n)];
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/sht.cfg',s,[]),null);
const source={sensor_type:'SHT3X',i2c_mcu:'aux',i2c_bus:'i2c1',min_temp:'0',max_temp:'100'};
for(const mode of ['sensor','fan','heater'])test(`configured SHT3X ${mode} publishes fractional humidity and CRC fault stops both MCUs`,async()=>{
 let temperature=25,fault=false;const humidity=33579*100/65535;
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_data,n)=>{const t=Math.round((temperature+45)*65535/175),data=n===3?Uint8Array.from(bytes(0)):n===6?Uint8Array.from([...bytes(t),...bytes(33579)]):Buffer.alloc(0);if(fault&&n===6)data[5]^=1;return {data};});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const section=mode==='heater'?'heater_generic chamber':`temperature_${mode} chamber`,aggregate='temperature_sensor aggregate';
 const sections:Record<string,Record<string,string>>={[section]:{...source,...mode==='sensor'?{gcode_id:'C'}:mode==='fan'?{pin:'PA4',control:'watermark',kick_start_time:'0'}:{heater_pin:'PA4',control:'watermark',min_extrude_temp:'0'}}};
 if(mode==='sensor')sections[aggregate]={sensor_type:'temperature_combined',sensor_list:section,combination_method:'mean',maximum_deviation:'1'};
 const until=async(check:()=>boolean)=>{const end=performance.now()+3000;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader(sections),f.group,f.clocks,{steppers:[],homing:[],fans:mode==='fan'?[{section,minimumScheduleTime:.02}]:[],heaters:mode==='heater'?[{section}]:[],sensors:mode==='heater'?[]:Object.keys(sections).map(section=>({section}))},{beforeTarget(){}},f.signal);
  const sensor=owner.i2cSensors[0];assert.equal(sensor.getTemperature().humidity,humidity);assert.equal(sensor.sensorStatus.humidity,51.2);assert.equal(sensor.statusName,'sht3x chamber');assert.equal(owner.plan.i2cSensors[0].address,68);assert.equal(owner.plan.i2cSensors[0].reportTime,1);
  if(mode==='sensor'){await until(()=>!owner!.combinedSensors[0].getTemperature().stale);assert.equal(owner.combinedSensors[0].getTemperature().humidity,humidity);}
  if(mode==='fan'){await until(()=>owner!.fans[0].runtime.status.speed===0);temperature=60;await until(()=>owner!.fans[0].runtime.status.speed===1);}
  if(mode==='heater'){await owner.heaters.setTarget('chamber',40,f.signal);await until(()=>owner!.thermal[0].runtime.objectStatus.power===1);temperature=60;await until(()=>owner!.thermal[0].runtime.objectStatus.power===0);}
  fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(sensor.getTemperature().stale,true);assert.match(String(owner.status.fault),/checksum/);
 }finally{await owner?.close();await f.close();}
});
test('mixed AHT and SHT3X reserve one bus but reject shared addresses across models',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_data,n)=>({data:Buffer.alloc(n)}));
 try{const a='temperature_sensor a',b='temperature_sensor b',sections={[a]:source,[b]:{...source,sensor_type:'AHT2X'}},layout={steppers:[],homing:[],fans:[],heaters:[],sensors:[{section:a},{section:b}]};
  assert.deepEqual(compileConfiguredHardware(reader(sections),f.group,f.clocks,layout).i2cSensors.map(p=>p.address),[68,56]);
  assert.throws(()=>compileConfiguredHardware(reader({...sections,[b]:{...sections[b],i2c_address:'68'}}),f.group,f.clocks,layout),/Duplicate I2C/);assert.equal(f.firmware.flatMap(f=>f.outputs).length,0);
 }finally{await f.close();}
});
