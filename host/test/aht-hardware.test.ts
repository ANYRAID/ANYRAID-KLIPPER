import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {hardwareStartupFixture} from './helpers/hardware-startup.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
const source={sensor_type:'AHT2X',i2c_mcu:'aux',i2c_bus:'i2c1',aht10_report_time:'5',gcode_id:'C'};
const reader=(sections:Record<string,Record<string,string>>)=>new ConfigurationReader(new ConfigurationSource('/aht.cfg',sections,[]),null);
const layout=(sections:string[])=>({steppers:[],homing:[],fans:[],heaters:[],sensors:sections.map(section=>({section}))});
test('configured AHT publishes humidity into combined sensors and bus faults stop both MCUs',async()=>{
 let fault=false;const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_bytes,n)=>({data:n?Uint8Array.of(8,128,0,6,0,0):Buffer.alloc(0),status:fault?'NACK':'SUCCESS'}));let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const sections={'temperature_sensor chamber':source,'temperature_sensor aggregate':{sensor_type:'temperature_combined',sensor_list:'temperature_sensor chamber',combination_method:'mean',maximum_deviation:'1'}};
 const until=async(check:()=>boolean)=>{const end=performance.now()+6500;while(!check()){assert(performance.now()<end);await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader(sections),f.group,f.clocks,layout(Object.keys(sections)),{beforeTarget(){}},f.signal);
  assert.equal(owner.status.state,'ready');assert.deepEqual(owner.i2cSensors[0].sensorStatus,{temperature:25,humidity:50});assert.equal(owner.heaters.report(),'C:25.0 /0.0');
  await until(()=>!owner!.combinedSensors[0].getTemperature().stale);assert.equal(owner.combinedSensors[0].getTemperature().humidity,50);
  fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(owner.i2cSensors[0].getTemperature().stale,true);assert.equal(owner.combinedSensors[0].getTemperature().stale,true);
 }finally{await owner?.close();await f.close();}
});
test('AHT configuration reserves shared bus wiring and rejects duplicate addresses or GPIO conflicts before IO',async()=>{
 const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_bytes,n)=>({data:Buffer.alloc(n)}));
 try{
  const a='temperature_sensor a',b='temperature_sensor b',base={...source,gcode_id:'A'};
  assert.throws(()=>compileConfiguredHardware(reader({[a]:base,[b]:{...base,gcode_id:'B'}}),f.group,f.clocks,layout([a,b])),/Duplicate I2C/);
  const plan=compileConfiguredHardware(reader({[a]:base,[b]:{...base,gcode_id:'B',i2c_address:'57'}}),f.group,f.clocks,layout([a,b]));assert.equal(plan.i2cSensors.length,2);assert.notEqual(plan.i2cSensors[0].protocol.oid,plan.i2cSensors[1].protocol.oid);
  assert.throws(()=>compileConfiguredHardware(reader({[a]:base,fan:{pin:'aux:PA17'}}),f.group,f.clocks,{...layout([a]),fans:[{section:'fan',minimumScheduleTime:.001}]}));
  const software={...base,i2c_software_scl_pin:'aux:PA17',i2c_software_sda_pin:'aux:PA18'};delete (software as Partial<typeof software>).i2c_bus;
  assert.match(compileConfiguredHardware(reader({[a]:software}),f.group,f.clocks,layout([a])).i2cSensors[0].protocol.configureBus,/i2c_set_sw_bus.*pulse_ticks=5/);
  assert.equal(f.firmware.flatMap(s=>s.outputs).length,0);
 }finally{await f.close();}
});
test('AHT cross-MCU fan survives slow reporting, controls PWM and stops on bus fault',async()=>{
 let temperature=25,fault=false;const f=await hardwareStartupFixture(false,false,true,true,false,(_oid,_bytes,n)=>{const raw=Math.round((temperature+50)*1048576/200);return {data:n?Uint8Array.of(8,128,0,raw>>>16,raw>>>8&255,raw&255):Buffer.alloc(0),status:fault?'NACK':'SUCCESS'};});let owner:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const section='temperature_fan chamber',settings={...source,pin:'PA4',control:'watermark',min_temp:'0',max_temp:'100',kick_start_time:'0'};
 const until=async(check:()=>boolean)=>{const end=performance.now()+6500;while(!check()){assert(performance.now()<end,'AHT fan observation timeout');await delay(10);}};
 try{
  owner=await startConfiguredHardware(reader({[section]:settings}),f.group,f.clocks,{...layout([section]),fans:[{section,minimumScheduleTime:.02}]},{beforeTarget(){}},f.signal);
  const fan=owner.fans[0].runtime;await until(()=>fan.status.speed===0);assert.equal(owner.heaters.report(),'C:25.0 /40.0');assert.equal(owner.plan.temperatureFans[0].sensorTimeout,11);assert.equal(owner.temperatureFans[0].control.reportDelay,.3);
  await delay(3300);assert.equal(owner.status.state,'ready');temperature=60;await until(()=>fan.status.speed===1);assert.equal(owner.i2cSensors[0].sensorStatus.humidity,50);
  fault=true;await until(()=>owner!.status.state!=='ready');await owner.close();assert.deepEqual(f.stops,[1,1]);assert.equal(fan.status.phase,'stopped');assert.equal(owner.plan.fans[0].config.shutdownPower,1);
 }finally{await owner?.close();await f.close();}
});
