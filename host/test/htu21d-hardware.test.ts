import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {htuCrc,decodeHtu21d,type HtuModel} from '../src/thermal/htu21d.ts';
const bytes=(n:number)=>[n>>>8,n&255,htuCrc(n)];
const reader=(s:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/htu.cfg',s,[]),null);
const source={sensor_type:'HTU21D',htu21d_report_time:'5',i2c_mcu:'aux',i2c_bus:'i2c1',min_temp:'0',max_temp:'100'};
for(const mode of ['sensor','fan','heater'])test(`configured HTU21D ${mode} publishes fractional humidity and CRC fault stops both MCUs`,async()=>{
 let temperature=25,fault=false;const model:HtuModel=mode==='fan'?'SI7021':mode==='heater'?'SHT21':'HTU21D',registers=new Map<number,number>(),pending=new Map<number,boolean>();const raw=(t:number)=>(Math.round((t+46.85)*65536/175.72)&65532),humidity=decodeHtu21d(Uint8Array.from(bytes(raw(25))),Uint8Array.from(bytes(30002)),model).humidity;
 const f=await hardwareStartupFixture(false,false,true,true,false,(oid,command,n)=>{if(command[0]===252)return {data:Uint8Array.from(bytes(0x3200))};if(command[0]===231)return {data:Uint8Array.of(registers.get(oid)??2)};if(command[0]===230){registers.set(oid,command[1]);return {data:Buffer.alloc(0)};}if([227,229,243,245].includes(command[0]))pending.set(oid,command[0]===229||command[0]===245);const data=n===3?Uint8Array.from(bytes(pending.get(oid)?30002:raw(temperature))):Buffer.alloc(n);if(fault&&n===3)data[2]^=1;return {data};});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const section=mode==='heater'?'heater_generic chamber':`temperature_${mode} chamber`,aggregate='temperature_sensor aggregate';
 const sections:Record<string,Record<string,string>>={[section]:{...source,sensor_type:model,htu21d_hold_master:String(mode==='fan'),...mode==='sensor'?{gcode_id:'C'}:mode==='fan'?{pin:'PA4',control:'watermark',kick_start_time:'0'}:{heater_pin:'PA4',control:'watermark',min_extrude_temp:'0'}}};
 if(mode==='sensor')sections[aggregate]={sensor_type:'temperature_combined',sensor_list:section,combination_method:'mean',maximum_deviation:'1'};
 const until=async(check:()=>boolean)=>{const end=performance.now()+8000;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader(sections),f.group,f.clocks,{steppers:[],homing:[],fans:mode==='fan'?[{section,minimumScheduleTime:.02}]:[],heaters:mode==='heater'?[{section}]:[],sensors:mode==='heater'?[]:Object.keys(sections).map(section=>({section}))},{beforeTarget(){}},f.signal);
  const sensor=owner.i2cSensors[0];assert.equal(sensor.getTemperature().humidity,humidity);assert.equal(sensor.sensorStatus.humidity,humidity);assert.equal(sensor.statusName,'htu21d chamber');assert.equal(owner.plan.i2cSensors[0].address,64);assert.equal(owner.plan.i2cSensors[0].reportTime,5);
  if(mode==='sensor'){await until(()=>!owner!.combinedSensors[0].getTemperature().stale);assert.equal(owner.combinedSensors[0].getTemperature().humidity,humidity);}
  if(mode==='fan'){await until(()=>owner!.fans[0].runtime.status.speed===0);temperature=60;await until(()=>owner!.fans[0].runtime.status.speed===1);}
  if(mode==='heater'){await owner.heaters.setTarget('chamber',40,f.signal);await until(()=>owner!.thermal[0].runtime.objectStatus.power===1);temperature=60;await until(()=>owner!.thermal[0].runtime.objectStatus.power===0);}
  fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(sensor.getTemperature().stale,true);assert.match(String(owner.status.fault),/checksum/);
 }finally{await owner?.close();await f.close();}
});
test('mixed AHT and HTU21D reserve one bus but reject shared addresses across models',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_data,n)=>({data:Buffer.alloc(n)}));
 try{const a='temperature_sensor a',b='temperature_sensor b',sections={[a]:source,[b]:{...source,sensor_type:'AHT2X'}},layout={steppers:[],homing:[],fans:[],heaters:[],sensors:[{section:a},{section:b}]};
  assert.deepEqual(compileConfiguredHardware(reader(sections),f.group,f.clocks,layout).i2cSensors.map(p=>p.address),[64,56]);
  assert.throws(()=>compileConfiguredHardware(reader({...sections,[b]:{...sections[b],i2c_address:'64'}}),f.group,f.clocks,layout),/Duplicate I2C/);assert.equal(f.firmware.flatMap(f=>f.outputs).length,0);
 }finally{await f.close();}
});
