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
async function fixture(software?:'modern'|'legacy',max31855=false,max31856=false,corrupt=false){
 const registers=Buffer.from([0x81,0x73,3]),transactions:{read:boolean;data:number[];at:number}[]=[];
 const chip=(oid:number,data:Uint8Array,read:boolean)=>{transactions.push({read,data:Array.from(data),at:performance.now()});const response=Buffer.alloc(data.length),address=data[0]&127;if(read){for(let i=1;i<data.length;i++)response[i]=registers[address+i-1]??0;if(corrupt&&data.length===4)response[2]^=1;}else{for(let i=1;i<data.length;i++)registers[address+i-1]=data[i];}return {data:response};};
 let stops=0;const firmware=await serialFirmware(undefined,{max6675:true,max31855,max31856,...max31856?{tmcSpi:chip}:{},extendedPins:true,spiSoftware:software}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);await group.start(signal);
 const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {firmware,group,clocks,transactions,get stops(){return stops;},async close(){await group.stop().catch(()=>{});await firmware.close();}};
}
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){assert(Date.now()<end,'Condition timed out');await delay(2);}}
test('MAX31855 report consumer publishes negative temperatures and rejects an isolated summary fault',async()=>{
 // Report-consumer coverage only. The fixture has a MAX6675 configuration
 // dictionary; it injects raw reports rather than emulating chip SPI reads.
 const f=await fixture(),samples:number[]=[],faults:string[]=[];
 try{
  const plan=compileConfiguredHardware(reader(),f.group,f.clocks,layout),p=plan.spiSensors[0],session=f.group.session('mcu');
  const sensor=new SerialThermocouple(session,{...p,model:'MAX31855',minimum:-10},p.timeline,{sample(_t,v){samples.push(v);},shutdown(reason){faults.push(reason);}});
  await session.configure(plan.configurations[0].plan,signal);sensor.activate();
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:0xfffc7ff0,fault:0});await until(()=>samples.length===1);assert.equal(samples[0],-.25);
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:0x00010000,fault:0});await until(()=>f.stops===1);assert.deepEqual(samples,[-.25]);assert.equal(faults.length,1);assert(sensor.status.closed);
 }finally{await f.close();}
});
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

for(const capable of [false,true])test('MAX31855 configuration signed firmware capability='+capable,async()=>{const f=await fixture(undefined,capable);try{const config=reader({sensor_type:'MAX31855',min_temp:'-10'});if(!capable){assert.throws(()=>compileConfiguredHardware(config,f.group,f.clocks,layout),/signed-range/);assert.equal(f.firmware.outputs.length,0);return;}const h=await startConfiguredHardware(config,f.group,f.clocks,layout,{beforeTarget(){}},signal),p=h.plan.spiSensors[0];assert.equal(p.model,'MAX31855');assert.match(p.commands[0],/thermocouple_type=MAX31855/);f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:0xfffc0000,fault:0});await until(()=>h.sensors[0].state.objectStatus.temperature===-.25);await h.close();}finally{await f.close();}});

for(const software of [undefined,'modern','legacy'] as const)test(`MAX31856 ${software??'hardware'} SPI initializes before sampling and preserves signed reports`,async()=>{
 const f=await fixture(software,false,true);try{
  const h=await startConfiguredHardware(reader({sensor_type:'MAX31856',min_temp:'-10',tc_type:'T',tc_averaging_count:'16',tc_use_50hz_filter:'True'},!!software),f.group,f.clocks,layout,{beforeTarget(){}},signal),p=h.plan.spiSensors[0];
  assert.match(p.spi.configureBus,/mode=1 /);assert(p.init[0].includes('rest_ticks=0 '));
  assert.deepEqual(f.transactions.filter(t=>!t.read).map(t=>t.data),[[0x80,1],[0x80,1,0x77,3],[0x80,0x81]]);
  const writes=f.transactions.filter(t=>!t.read);assert(writes[1].at-writes[0].at>=990,'conversion did not settle before changing settings');
  const queries=f.firmware.outputs.filter(o=>o.name==='query_thermocouple');assert.equal(queries.length,2);assert.equal(queries[0].parameters.rest_ticks,0);assert.equal(queries[1].parameters.rest_ticks,p.reportTicks);
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:0xffffff,fault:0});await until(()=>h.sensors[0].state.getTemperature().temperature===-1/128);
  f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:0,fault:128});await until(()=>f.stops===1);assert.equal(h.sensors[0].state.getTemperature().temperature,-1/128);await h.close();
 }finally{await f.close();}
});
test('MAX31856 rejects old firmware and invalid settings without MCU writes',async()=>{
 const old=await fixture();try{assert.throws(()=>compileConfiguredHardware(reader({sensor_type:'MAX31856'}),old.group,old.clocks,layout),/signed-range/);assert.equal(old.firmware.outputs.length,0);}finally{await old.close();}
 const f=await fixture(undefined,false,true);try{for(const change of ([{tc_type:'X'},{tc_averaging_count:'3'},{tc_use_50hz_filter:'maybe'}] as Record<string,string>[]))assert.throws(()=>compileConfiguredHardware(reader({sensor_type:'MAX31856',...change}),f.group,f.clocks,layout));assert.equal(f.firmware.outputs.length,0);}finally{await f.close();}
});
test('MAX31856 mismatched readback stops hardware before arming sampling',async()=>{
 const f=await fixture(undefined,false,true,true);try{
  await assert.rejects(startConfiguredHardware(reader({sensor_type:'MAX31856'}),f.group,f.clocks,layout,{beforeTarget(){}},signal),/readback/);assert.equal(f.stops,1);assert(f.firmware.outputs.filter(o=>o.name==='query_thermocouple').every(o=>o.parameters.rest_ticks===0));
 }finally{await f.close();}
});
for(const pid of [false,true])test(`MAX31856 automatic ${pid?'PID':'watermark'} heater registration initializes then controls and stops on fault`,async()=>{
 const f=await fixture(undefined,false,true);try{
  const config=new ConfigurationReader(new ConfigurationSource('/heater.cfg',{'heater_generic chamber':{sensor_type:'MAX31856',sensor_pin:'PA0',spi_bus:'spi1',heater_pin:'PA1',min_temp:'-10',max_temp:'300',control:pid?'pid':'watermark',...pid?{pid_kp:'22',pid_ki:'1.08',pid_kd:'114'}:{}}},[]),null);
  const h=await startConfiguredHardware(config,f.group,f.clocks,{...layout,sensors:[],heaters:[{section:'heater_generic chamber'}]},{beforeTarget(){}},signal),p=h.plan.spiHeaters[0].sensor;
  const emit=(fault=0)=>f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:25*4096,fault});
  emit();await until(()=>h.spiHeaters[0].runtime.status.received);await h.heaters.setTarget('chamber',200,signal);await delay(5);emit();await until(()=>h.spiHeaters[0].runtime.objectStatus.power>0);
  await delay(5);emit(1);await until(()=>f.stops===1);await h.close();assert.equal(h.spiHeaters[0].runtime.status.target,0);assert(h.spiHeaters[0].runtime.status.outputStopConfirmed);
 }finally{await f.close();}
});
test('MAX31856 startup abort does not arm sampling or enable conversion',async()=>{
 const f=await fixture(undefined,false,true),abort=new AbortController();try{
  const starting=startConfiguredHardware(reader({sensor_type:'MAX31856'}),f.group,f.clocks,layout,{beforeTarget(){}},abort.signal);void starting.catch(()=>{});
  await until(()=>f.transactions.some(t=>!t.read));abort.abort(new Error('startup cancelled'));await assert.rejects(starting,{name:'AbortError'});assert.equal(f.stops,1);
  assert.equal(f.transactions.filter(t=>!t.read).length,1);assert(f.firmware.outputs.filter(o=>o.name==='query_thermocouple').every(o=>o.parameters.rest_ticks===0));
 }finally{await f.close();}
});
