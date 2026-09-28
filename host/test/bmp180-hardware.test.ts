import {bmp180Device,bmp180Calibration} from './helpers/bmp180-device.ts';
import {Bmp180Compensation} from '../src/thermal/bmp180.ts';
const compensation=new Bmp180Compensation(bmp180Calibration()),expected=compensation.decode(27898,23843*4,2);
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/bme.cfg',s,[]),null);
const source={sensor_type:'BME280',i2c_mcu:'aux',i2c_bus:'i2c1',i2c_address:'119',min_temp:'-55',max_temp:'100'};
for(const mode of ['sensor','fan','heater'])test(`configured BMP180 ${mode} publishes pressure and model-specific humidity and NACK fault stops both MCUs`,async()=>{
 let temperature=27898;const device=bmp180Device();
 const f=await hardwareStartupFixture(false,false,true,true,false,(oid,data,n)=>{device.state.rawTemperature=temperature;return device.exchange(oid,data,n);});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const section=mode==='heater'?'heater_generic chamber':`temperature_${mode} chamber`,aggregate='temperature_sensor aggregate';
 const sections:Record<string,Record<string,string>>={[section]:{...source,...mode==='sensor'?{gcode_id:'C'}:mode==='fan'?{pin:'PA4',control:'watermark',kick_start_time:'0'}:{heater_pin:'PA4',control:'watermark',min_extrude_temp:'0'}}};
 if(mode==='sensor')sections[aggregate]={sensor_type:'temperature_combined',sensor_list:section,combination_method:'mean',maximum_deviation:'1'};
 const until=async(check:()=>boolean)=>{const end=performance.now()+3000;while(!check()){assert(performance.now()<end,JSON.stringify({status:owner?.status,fault:String(owner?.status.fault),source:owner?.i2cSensors[0].getTemperature(),combined:owner?.combinedSensors[0]?.getTemperature()}));await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader(sections),f.group,f.clocks,{steppers:[],homing:[],fans:mode==='fan'?[{section,minimumScheduleTime:.02}]:[],heaters:mode==='heater'?[{section}]:[],sensors:mode==='heater'?[]:Object.keys(sections).map(section=>({section}))},{beforeTarget(){}},f.signal);
  const sensor=owner.i2cSensors[0];assert.equal(sensor.getTemperature().pressure,expected.pressure);assert.equal(sensor.sensorStatus.pressure,expected.pressure);assert.equal(sensor.getTemperature().temperature,expected.temperature);assert.equal(sensor.getTemperature().humidity,undefined);assert.equal(sensor.sensorStatus.humidity,undefined);assert.equal(sensor.statusName,'bme280 chamber');assert.equal(owner.plan.i2cSensors[0].address,119);assert.equal(owner.plan.i2cSensors[0].reportTime,.8);
  if(mode==='sensor'){await until(()=>!owner!.combinedSensors[0].getTemperature().stale);assert.equal(owner.combinedSensors[0].getTemperature().humidity,undefined);assert.equal(owner.combinedSensors[0].getTemperature().pressure,expected.pressure);}
  if(mode==='fan'){await until(()=>owner!.fans[0].runtime.status.speed===0);temperature=35000;await until(()=>owner!.fans[0].runtime.status.speed===1);}
  if(mode==='heater'){await owner.heaters.setTarget('chamber',40,f.signal);await until(()=>owner!.thermal[0].runtime.objectStatus.power===1);temperature=35000;await until(()=>owner!.thermal[0].runtime.objectStatus.power===0);}
  device.state.fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(sensor.getTemperature().stale,true);assert.match(String(owner.status.fault),/I2C|NACK/);
 }finally{await owner?.close();await f.close();}
});
