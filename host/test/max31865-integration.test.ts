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
const reader=(extra:Record<string,string>={},software=false,heater=false,pid=false)=>new ConfigurationReader(new ConfigurationSource('/rtd.cfg',{[heater?'heater_generic chamber':'temperature_sensor chamber']:{sensor_type:'MAX31865',sensor_pin:'PA0',...software?{spi_software_miso_pin:'PA6',spi_software_mosi_pin:'PA7',spi_software_sclk_pin:'PA8'}:{spi_bus:'spi1'},min_temp:'-200',max_temp:'300',...heater?{heater_pin:'PA1',control:pid?'pid':'watermark',...pid?{pid_kp:'22',pid_ki:'1.08',pid_kd:'114'}:{}}:{},...extra}},[]),null);
async function fixture(software?:'modern'|'legacy',failure?:'readback'|'fault'|'malformed'){
 let stops=0;const registers=Buffer.from([0xd1,0,0,1,2,3,4,0]),writes:number[][]=[];
 const firmware=await serialFirmware(undefined,{max31865:true,extendedPins:true,spiSoftware:software,tmcSpi(_oid,data,read){
  const result=Buffer.alloc(data.length),address=data[0]&127;
  if(read){if(failure==='malformed')return {data:Buffer.alloc(0)};for(let i=1;i<data.length;i++)result[i]=registers[address+i-1];if(failure==='readback'&&address===3)result[1]^=1;if(failure==='fault'&&address===7)result[1]=4;}
  else{writes.push(Array.from(data));for(let i=1;i<data.length;i++)registers[address+i-1]=data[i];if(address===0){registers[0]&=~2;if(data[1]&2)registers[7]=0;}}
  return {data:result};
 }}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]);await group.start(signal);
 const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {firmware,group,clocks,registers,writes,get stops(){return stops;},async close(){await group.stop().catch(()=>{});await firmware.close();}};
}
async function until(check:()=>boolean){const end=Date.now()+2000;while(!check()){assert(Date.now()<end,'Condition timed out');await delay(2);}}
for(const software of [undefined,'modern','legacy'] as const)for(const wires of [2,3,4])test(`MAX31865 ${software??'hardware'} SPI ${wires}-wire config, negative sample and fault`,async()=>{
 const f=await fixture(software);try{
  const h=await startConfiguredHardware(reader({rtd_num_of_wires:String(wires),rtd_use_50hz_filter:'True',rtd_nominal_r:'1000',rtd_reference_r:'4300'},!!software),f.group,f.clocks,layout,{beforeTarget(){}},signal),p=h.plan.spiSensors[0],bias=0x81|(wires===3?16:0);
  assert.match(p.spi.configureBus,/mode=1 /);assert.deepEqual(f.writes,[[128,0x91],[128,bias|2],[131,255,255,0,0],[128,bias|64]]);assert.equal(f.registers[0],bias|64);
  const queries=f.firmware.outputs.filter(e=>e.name==='query_thermocouple');assert.deepEqual(queries.map(e=>e.parameters.rest_ticks),[0,300000]);assert.equal(queries[1].parameters.min_value,p.range.minimum);assert.equal(queries[1].parameters.max_value,p.range.maximum);
  const raw=7000*2,expected=p.rtd!.temperature(raw);assert(expected<0);f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:raw,fault:0});await until(()=>h.sensors[0].state.getTemperature().temperature===expected);
  await delay(3);f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:raw|1,fault:0});await until(()=>f.stops===1);assert.equal(h.sensors[0].state.getTemperature().temperature,expected);await h.close();
 }finally{await f.close();}
});
for(const pid of [false,true])test(`MAX31865 ${pid?'PID':'watermark'} heater feedback and fault stop`,async()=>{
 const f=await fixture();try{
  const h=await startConfiguredHardware(reader({},false,true,pid),f.group,f.clocks,{...layout,sensors:[],heaters:[{section:'heater_generic chamber'}]},{beforeTarget(){}},signal),p=h.plan.spiHeaters[0].sensor;
  const emit=(fault=0)=>f.firmware.emit('thermocouple_result',{oid:p.oid,next_clock:(f.firmware.currentClock()+p.reportTicks)>>>0,value:8360*2,fault});
  emit();await until(()=>h.spiHeaters[0].runtime.status.received);await h.heaters.setTarget('chamber',200,signal);await delay(5);emit();await until(()=>h.spiHeaters[0].runtime.objectStatus.power>0);
  await delay(5);emit(4);await until(()=>f.stops===1);await h.close();assert.equal(h.spiHeaters[0].runtime.status.target,0);assert(h.spiHeaters[0].runtime.status.outputStopConfirmed);
 }finally{await f.close();}
});
for(const failure of ['readback','fault','malformed'] as const)test('MAX31865 startup rejects '+failure,async()=>{
 const f=await fixture(undefined,failure);try{await assert.rejects(startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},signal),/MAX31865/);assert.equal(f.stops,1);assert(f.firmware.outputs.filter(e=>e.name==='query_thermocouple').every(e=>e.parameters.rest_ticks===0));}finally{await f.close();}
});
test('MAX31865 invalid parameters fail before I/O and cancelled startup cannot arm sampling',async()=>{
 const f=await fixture();try{
  const invalid:Record<string,string>[]=[{rtd_num_of_wires:'1'},{rtd_num_of_wires:'5'},{rtd_nominal_r:'0'},{rtd_reference_r:'NaN'},{rtd_use_50hz_filter:'maybe'},{min_temp:'900',max_temp:'1000'}];for(const extra of invalid)assert.throws(()=>compileConfiguredHardware(reader(extra),f.group,f.clocks,layout));assert.equal(f.firmware.outputs.length,0);
  const abort=new AbortController(),starting=startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},abort.signal);void starting.catch(()=>{});await until(()=>f.writes.length===1);abort.abort();await assert.rejects(starting);assert.equal(f.stops,1);assert(f.firmware.outputs.filter(e=>e.name==='query_thermocouple').every(e=>e.parameters.rest_ticks===0));
 }finally{await f.close();}
});
