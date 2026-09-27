import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {tmc220xStatusReader} from '../src/drivers/tmc220x-status.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const layout={steppers:[{section:'stepper_x',emitter:'x',enableLeadTime:.001},{section:'stepper_y',emitter:'y',enableLeadTime:.001,requestBothEdges:true}],homing:[],fans:[],heaters:[]};
const reader=(change:Record<string,string>={},software=false)=>new ConfigurationReader(new ConfigurationSource('/spi.cfg',{
 stepper_x:{step_pin:'PA0',dir_pin:'PA1',enable_pin:'!PA2',rotation_distance:'40',microsteps:'16'},stepper_y:{step_pin:'PA4',dir_pin:'PA5',enable_pin:'!PA2',rotation_distance:'40',microsteps:'32',step_pulse_duration:'.0000001'},
 'tmc2130 stepper_x':{cs_pin:'PA9',spi_bus:'spi1',...software?{spi_software_miso_pin:'PA6',spi_software_mosi_pin:'PA7',spi_software_sclk_pin:'PA8'}:{},chain_length:'2',chain_position:'1',run_current:'.8'},
 'tmc2130 stepper_y':{cs_pin:'PA9',spi_bus:'spi1',...software?{spi_software_miso_pin:'PA6',spi_software_mosi_pin:'PA7',spi_software_sclk_pin:'PA8'}:{},chain_length:'2',chain_position:'2',run_current:'.9',...change}
},[]),null);
async function fixture(bad=false,software?:'modern'|'legacy'){
 const registers=new Map<number,number>(),writes:number[][]=[];let latched=Buffer.alloc(10),fault=0,stops=0;
 const firmware=await serialFirmware(undefined,{extendedPins:true,stepperBytePins:true,spiSoftware:software,tmcSpi(_oid,frame){
  if(bad)return {data:Buffer.alloc(0)};const previous=latched;latched=Buffer.alloc(10);const b=Buffer.from(frame);
  for(let i=0;i<10;i+=5){const r=b[i]&127,key=i*128+r;if(b[i]&128){writes.push([i,r,b.readUInt32BE(i+1)]);registers.set(key,b.readUInt32BE(i+1));}latched.writeUInt32BE(r===0x6f?fault:r===1?0:registers.get(key)??0,i+1);}return {data:previous};
 }}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]),signal=new AbortController().signal;
 await group.start(signal);const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {group,signal,clocks,firmware,writes,setFault(v:number){fault=v;},get stops(){return stops;},async close(){await group.stop();await firmware.close();}};
}
test('two chained SPI drivers initialize with one OID, controlled enables and matched double-edge mode',async t=>{
 const f=await fixture();try{
  const start=performance.now(),h=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);t.diagnostic(JSON.stringify({startupMs:performance.now()-start,scope:'Two chained TMC2130 drivers with native serialqueue and simulated SPI'}));
  assert.equal(h.status.state,'ready');assert.equal(h.plan.tmcUarts.length,0);assert.equal(h.plan.tmcSpis.length,1);assert.equal(h.plan.tmcSpis[0].spi.oid,3);
  for(const {position,plan} of h.plan.tmcSpis[0].devices)assert.deepEqual(f.writes.filter(w=>w[0]===(2-position)*5).map(w=>w.slice(1)),plan.registers.map(r=>[r.address,r.value]));
  const y=h.plan.tmcSpis[0].devices[1].plan;assert(y.registers.find(r=>r.name==='CHOPCONF')!.value&0x20000000);assert.equal(h.plan.steppers[1].bothEdges,true);
  const enable=f.firmware.outputs.find(e=>e.name==='config_digital_out')!;assert.equal(enable.parameters.value,1);assert.equal(enable.parameters.default_value,1);
  const state=tmc220xStatusReader(y,{status:{...h.drivers[1].monitor.status,drvStatus:0x84010005}})();assert.deepEqual(state.drv_status,{sg_result:5,cs_actual:1,otpw:1,stst:1});
  f.setFault(1<<25);const deadline=Date.now()+3000;while(h.status.state==='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));await h.close();assert.equal(f.stops,1);assert(h.drivers.some(d=>d.monitor.status.fault));assert(h.drivers.every(d=>d.monitor.status.closed));
 }finally{await f.close();}
});
test('SPI conflicts fail before I/O and all chip selects precede bus activation',async()=>{
 const f=await fixture();try{
  for(const change of [{chain_position:'1'},{spi_speed:'1000000'},{cs_pin:'PA6'},{spi_software_sclk_pin:'PA10'},{spi_bus:'unknown'}] as Record<string,string>[])assert.throws(()=>compileConfiguredHardware(reader(change),f.group,f.clocks,layout));
  let raw=structuredClone(reader().source.original);raw.stepper_x.step_pin='PA7';assert.throws(()=>compileConfiguredHardware(new ConfigurationReader(new ConfigurationSource('/spi.cfg',raw,[]),null),f.group,f.clocks,layout),/multiple/);
  raw=structuredClone(reader().source.original);raw['tmc2209 stepper_x']={uart_pin:'PA10',run_current:'.8'};assert.throws(()=>compileConfiguredHardware(new ConfigurationReader(new ConfigurationSource('/spi.cfg',raw,[]),null),f.group,f.clocks,layout),/Duplicate/);
  assert.equal(f.firmware.stepperConfigs.length,0);assert.equal(f.writes.length,0);
  const plan=compileConfiguredHardware(reader({cs_pin:'PA10'}),f.group,f.clocks,layout),commands=plan.configurations[0].plan.commands;assert.equal(plan.tmcSpis.length,2);assert(commands.findLastIndex(c=>c.startsWith('config_spi '))<commands.findIndex(c=>c.startsWith('spi_set_bus ')));
 }finally{await f.close();}
});
test('failed SPI startup never publishes ready or enables motors',async()=>{
 const f=await fixture(true);try{await assert.rejects(startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),/Malformed/);assert.equal(f.stops,1);assert(!f.firmware.outputs.some(e=>e.name==='update_digital_out'&&e.parameters.value===0));}finally{await f.close();}
});

for(const software of ['modern','legacy'] as const)test(`software SPI ${software} initializes chained drivers without hardware bus commands`,async()=>{
 const f=await fixture(false,software);try{
  const h=await startConfiguredHardware(reader({},true),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);assert.equal(h.status.state,'ready');
  const command=h.plan.tmcSpis[0].spi.configureBus;assert.match(command,software==='modern'?/pulse_ticks=0$/:/rate=4000000$/);assert(!f.firmware.outputs.some(e=>e.name==='spi_set_bus'));assert.equal(f.writes.length,38);await h.close();
 }finally{await f.close();}
});
test('software SPI reserves physical pins and rejects mixed chain wiring before I/O',async()=>{
 const f=await fixture(false,'modern');try{
  for(const change of [{spi_software_miso_pin:'PA0'},{spi_software_mosi_pin:'PA6'},{spi_software_sclk_pin:'PA7'}] as Record<string,string>[])assert.throws(()=>compileConfiguredHardware(reader(change,true),f.group,f.clocks,layout));
  const raw=structuredClone(reader({},true).source.original);raw['tmc2130 stepper_x'].spi_software_miso_pin='PA0';raw['tmc2130 stepper_y'].spi_software_miso_pin='PA0';assert.throws(()=>compileConfiguredHardware(new ConfigurationReader(new ConfigurationSource('/spi.cfg',raw,[]),null),f.group,f.clocks,layout),/multiple/);
  assert.equal(f.writes.length,0);assert.equal(f.firmware.stepperConfigs.length,0);assert.equal(compileConfiguredHardware(reader({},true),f.group,f.clocks,layout).tmcSpis[0].spi.oid,3);
 }finally{await f.close();}
});
