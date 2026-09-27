import {SerialThermocouple} from '../src/thermal/serial-thermocouple.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const signal=new AbortController().signal,layout={steppers:[],homing:[],fans:[],heaters:[],sensors:[{section:'temperature_sensor chamber'}]};
const reader=(change:Record<string,string>={},software=false)=>new ConfigurationReader(new ConfigurationSource('/spi-temperature.cfg',{'temperature_sensor chamber':{sensor_type:'MAX6675',sensor_pin:'PA0',...software?{spi_software_miso_pin:'PA6',spi_software_mosi_pin:'PA7',spi_software_sclk_pin:'PA8'}:{spi_bus:'spi1'},min_temp:'0',max_temp:'100',gcode_id:'C',...change}},[]),null);
async function fixture(software?:'modern'|'legacy'){
 let stops=0;const firmware=await serialFirmware(undefined,{max6675:true,extendedPins:true,spiSoftware:software}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);await group.start(signal);
 const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {firmware,group,clocks,get stops(){return stops;},async close(){await group.stop().catch(()=>{});await firmware.close();}};
}
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){assert(Date.now()<end,'Condition timed out');await delay(2);}}
for(const software of [undefined,'modern','legacy'] as const)test(`MAX6675 ${software??'hardware'} SPI starts with mode zero and fault stops whole hardware`,async()=>{
 const f=await fixture(software);try{
  const h=await startConfiguredHardware(reader({},!!software),f.group,f.clocks,layout,{beforeTarget(){}},signal),p=h.plan.spiSensors[0];
  assert.equal(h.status.state,'ready');assert.equal(h.plan.configurations[0].plan.oidCount,2);assert.match(p.spi.configureBus,/mode=0 /);assert(p.init[0].includes('max_value=3201'));assert.equal(h.sensors.length,1);
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:42*32,fault:0});await until(()=>h.sensors[0].state.objectStatus.temperature===42);assert.equal(h.sensors[0].state.getTemperature().target,0);
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:4,fault:4});await until(()=>f.stops===1);await h.close();assert(h.sensors[0].state.getTemperature().stale);assert.equal(h.sensors[0].state.objectStatus.temperature,42);
 }finally{await f.close();}
});
test('SPI sensor configuration rejects bus/pin/range conflicts before MCU I/O',async()=>{
 const f=await fixture();try{
  const changes:Record<string,string>[]=[{sensor_pin:'!PA0'},{sensor_pin:'PA6'},{sensor_pin:'missing'},{spi_bus:'missing'},{spi_speed:'5000000'},{min_temp:'50',max_temp:'40'},{min_temp:'100.01',max_temp:'100.1'},{gcode_id:'bad id'},{spi_software_miso_pin:'PA6'}];for(const change of changes)assert.throws(()=>compileConfiguredHardware(reader(change),f.group,f.clocks,layout));
  assert.equal(f.firmware.outputs.length,0);const p=compileConfiguredHardware(reader(),f.group,f.clocks,layout);assert.equal(p.spiSensors[0].oid,1);
 }finally{await f.close();}
});
for(const failure of ['missing','stale','future','duplicate','range','reserved','consumer'] as const)test(`SPI sensor ${failure} stops its session without publishing invalid samples`,async()=>{
 const f=await fixture();let offset=0,tick:(()=>void)|undefined,cancelled=0;const samples:number[]=[],faults:string[]=[];
 try{
  const plan=compileConfiguredHardware(reader(),f.group,f.clocks,layout),p=plan.spiSensors[0],session=f.group.session('mcu');
  const request={...p},sensor=new SerialThermocouple(session,request,p.timeline,{sample(_t,v){if(failure==='consumer')throw new Error('consumer failed');samples.push(v);},shutdown(reason){faults.push(reason);}},{now:()=>serialClock.now()+offset,schedule(cb){tick=cb;return ()=>{cancelled++;tick=undefined;};}});
  request.oid=250;request.minimum=999;
  await session.configure(plan.configurations[0].plan,signal);
  const next=(f.firmware.currentClock()+p.reportTicks)>>>0;
  if(failure==='missing'){sensor.activate();offset=8;tick!();}
  else if(failure==='future'){sensor.activate();f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(next+2000000)>>>0,value:32,fault:0});}
  else if(failure==='range'||failure==='reserved'){sensor.activate();f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:next,value:failure==='range'?101*32:0x8000,fault:0});}
  else{
   f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:next,value:42*32,fault:0});await until(()=>sensor.status.lastSample!==undefined);assert.equal(samples.length,0);
   if(failure==='consumer')assert.throws(()=>sensor.activate(),/consumer/);
   else{sensor.activate();assert.deepEqual(samples,[42]);if(failure==='stale'){offset=8;tick!();}else f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:next,value:20*32,fault:0});}
  }
  await until(()=>f.stops===1);assert.equal(sensor.status.closed,true);assert.equal(faults.length,1);assert.equal(samples.length,['stale','duplicate'].includes(failure)?1:0);assert.equal(cancelled,failure==='consumer'?0:1);assert.throws(()=>sensor.activate(),/restart/);
 }finally{await f.close();}
});
