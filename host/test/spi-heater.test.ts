import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {attachConfiguredSpiHeater} from '../src/config/spi-heater.ts';
import {attachConfiguredSpiSensor} from '../src/config/spi-temperature.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=new AbortController().signal,layout={steppers:[],homing:[],fans:[],heaters:[{section:'heater_generic chamber'}],sensors:[]};
const reader=(changes:Record<string,string>={},pid=false)=>new ConfigurationReader(new ConfigurationSource('/spi-heater.cfg',{'heater_generic chamber':{sensor_type:'MAX6675',sensor_pin:'PA0',spi_bus:'spi1',heater_pin:'!PA1',min_temp:'0',max_temp:'300',control:pid?'pid':'watermark',...pid?{pid_kp:'22',pid_ki:'1.08',pid_kd:'114'}:{},...changes}},[]),null);
async function fixture(max31855=false){
 let stops=0;const firmware=await serialFirmware(undefined,{max6675:true,max31855,extendedPins:true}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);await group.start(signal);
 const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {firmware,group,clocks,get stops(){return stops;},async close(){await group.stop().catch(()=>{});await firmware.close();}};
}
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){assert(Date.now()<end,'Condition timed out');await delay(2);}}
for(const model of ['MAX6675','MAX31855'] as const)for(const fault of ['open','range','stale'] as const)for(const pid of [false,true])test(`${model} heater ${pid?'PID':'watermark'} buffers samples, confirms output reset and stops on ${fault}`,async()=>{
 const f=await fixture(model==='MAX31855');let offset=0,tick:(()=>void)|undefined;
 try{
  const plan=compileConfiguredHardware(reader({sensor_type:model,min_temp:model==='MAX31855'?'-10':'0'},pid),f.group,f.clocks,layout),p=plan.spiHeaters[0],binding=attachConfiguredSpiHeater(f.group,p,{sensor:{now:()=>serialClock.now()+offset,schedule(cb){tick=cb;return ()=>{tick=undefined;};}}}),runtime=binding.runtime;
  assert.equal(plan.heaters.length,0);assert.equal(plan.allHeaters[0],p);assert.equal(p.output.pwm.maximumDuration,3);assert.equal(p.output.pwm.invert,1);
  assert.throws(()=>attachConfiguredSpiHeater(f.group,p),/reused/);assert.throws(()=>attachConfiguredSpiSensor(f.group,p.sensor),/reused/);assert.throws(()=>attachConfiguredSpiHeater(f.group,{...p}),/Invalid/);
  await f.group.session('mcu').configure(plan.configurations[0].plan,signal);
  const emit=(temperature:number,fault=0)=>f.firmware.emit('thermocouple_result',{oid:p.sensor.oid,next_clock:(f.firmware.currentClock()+p.sensor.reportTicks)>>>0,value:model==='MAX31855'?((temperature*4)&0x3fff)*262144:temperature*32,fault});
  emit(25);await until(()=>binding.sensor.status.lastSample!==undefined);assert.equal(runtime.status.received,false);
  await binding.start(signal);assert.equal(runtime.status.lastTemperature,25);await runtime.setTarget(200,signal);await delay(5);emit(25);
  await until(()=>runtime.objectStatus.power>0&&runtime.status.pendingWrites===0);assert(f.firmware.outputs.some(e=>e.name==='queue_digital_out_generation'));
  await runtime.setTarget(0,signal);assert.equal(binding.outputStatus?.defaultConfirmed,true);assert.equal(runtime.status.target,0);assert.equal(runtime.status.pendingWrites,0);
  await runtime.setTarget(200,signal);
  if(fault==='stale'){offset=8;tick!();}else{await delay(5);emit(fault==='range'?301:25,fault==='open'?4:0);}
  await until(()=>f.stops===1&&runtime.status.stopped&&binding.sensor.status.closed);await binding.stop();assert.equal(runtime.status.outputStopConfirmed,true);assert.equal(runtime.status.target,0);
 }finally{await f.close();}
});
test('automatic SPI heater registration refuses stale targets and shares bus with independent sensor',async()=>{
 const f=await fixture();try{
  const config=new ConfigurationReader(new ConfigurationSource('/shared.cfg',{...reader().source.original,'temperature_sensor case':{sensor_type:'MAX6675',sensor_pin:'PA2',spi_bus:'spi1',min_temp:'0',max_temp:'100'}},[]),null),h=await startConfiguredHardware(config,f.group,f.clocks,{...layout,sensors:[{section:'temperature_sensor case'}]},{beforeTarget(){}},signal);
  assert.equal(h.thermal.length,1);assert.equal(h.spiHeaters.length,1);assert.equal(h.sensors.length,1);assert.equal(h.plan.configurations[0].plan.oidCount,5);
  await assert.rejects(h.heaters.setTarget('chamber',200,signal),/Fresh/);assert.equal(h.spiHeaters[0].runtime.status.target,0);
  assert.equal(f.firmware.outputs.filter(e=>e.name==='queue_digital_out_generation').length,0);await h.close();assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('SPI heater range, output pin and configuration errors fail before MCU writes',async()=>{
 const f=await fixture();try{
  const changes:Record<string,string>[]=[{heater_pin:'PA0'},{heater_pin:'PA6'},{heater_pin:'missing'},{max_temp:'1024'},{min_temp:'-1'},{min_temp:'20.01',max_temp:'20.1'},{control:'unknown'},{pwm_cycle_time:'.4'},{max_power:'2'}];
  for(const change of changes)assert.throws(()=>compileConfiguredHardware(reader(change),f.group,f.clocks,layout));
  assert.equal(f.firmware.outputs.length,0);assert.equal(compileConfiguredHardware(reader(),f.group,f.clocks,layout).spiHeaters.length,1);
 }finally{await f.close();}
});
