import test from 'node:test';
import assert from 'node:assert/strict';
import {ConfigurationReader} from '../src/moonraker/config-reader.ts';
import {ConfigurationSource} from '../src/moonraker/config-source.ts';
import {compileConfiguredHardware} from '../src/config/hardware.ts';
import {startConfiguredHardware} from '../src/runtime/configured-hardware.ts';
import {MCUGroup} from '../src/runtime/mcu-group.ts';
import {SerialSession} from '../src/protocol/serial-session.ts';
import {serialClock} from '../src/protocol/serial-queue.ts';
import {encodeTmcWrite} from '../src/drivers/tmc-uart.ts';
import {serialFirmware} from './helpers/serial-firmware.ts';
const layout={steppers:[{section:'stepper_x',emitter:'x',enableLeadTime:.001},{section:'stepper_y',emitter:'y',enableLeadTime:.001,requestBothEdges:true}],homing:[],fans:[],heaters:[]};
function reader(change:Record<string,string>={}){return new ConfigurationReader(new ConfigurationSource('/tmc.cfg',{
 stepper_x:{step_pin:'PA0',dir_pin:'PA1',enable_pin:'!PA2',rotation_distance:'40',microsteps:'16'},
 stepper_y:{step_pin:'PA4',dir_pin:'PA5',enable_pin:'!PA2',rotation_distance:'40',microsteps:'32',step_pulse_duration:'.0000001'},
 'tmc2209 stepper_x':{uart_pin:'^PA3',uart_address:'0',run_current:'.8'},
 'tmc2209 stepper_y':{uart_pin:'^PA3_ALIAS',uart_address:'1',run_current:'.9',...change}
 },[]),null);}
async function fixture(bad=false){
 const counts=new Map<number,number>(),writes:{address:number;register:number;value:number}[]=[];let stops=0,fault=0;
 const firmware=await serialFirmware(undefined,{extendedPins:true,stepperBytePins:true,tmcUart(_oid,frame,n){
  const byte=(i:number)=>{const bit=i*10+1;return ((frame[bit>>>3]|frame[(bit>>>3)+1]<<8)>>>(bit&7))&255;};const address=byte(1),register=byte(2)&127;
  if(bad)return {data:Buffer.alloc(0)};
  if(n)return {data:encodeTmcWrite(255,register,register===2?counts.get(address)??255:register===1?fault:0,true)};
  writes.push({address,register,value:byte(3)*2**24+byte(4)*65536+byte(5)*256+byte(6)});counts.set(address,((counts.get(address)??255)+1)&255);return {data:Buffer.alloc(0),delayMs:2};
 }}),group=new MCUGroup([{id:'mcu',async connect(s,stopDevice){const session=new SerialSession(firmware.fd,{stopDevice});await session.initialize(s);return session;},async stopDevice(){stops++;}}]),signal=new AbortController().signal;
 await group.start(signal);const clocks=new Map([['mcu',{currentPrintTime:Number(group.session('mcu').clock.sync.getClock(serialClock.now()))/1e6,calibration:{offset:0,frequency:1e6}}]]);
 return {group,signal,clocks,firmware,writes,setFault(value:number){fault=value;},get stops(){return stops;},async close(){await group.stop();await firmware.close();}};
}
test('hardware initializes shared UART drivers with unique OID, disabled motors and matched edge mode',async t=>{
 const f=await fixture();try{
  const start=performance.now(),hardware=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);t.diagnostic(JSON.stringify({startupMs:performance.now()-start,scope:'Two TMC2209 drivers, shared UART, simulated 2ms write completion; includes hardware configuration'}));
  assert.equal(hardware.status.state,'ready');assert.equal(hardware.plan.tmcUarts.length,1);assert.equal(hardware.plan.tmcUarts[0].devices.length,2);
  assert.equal(new Set(hardware.plan.configurations[0].resources.owners.map(r=>r.oid)).size,4);
  for(const device of hardware.plan.tmcUarts[0].devices)assert.deepEqual(f.writes.filter(w=>w.address===device.address).map(w=>({register:w.register,value:w.value})),device.registers.map(r=>({register:r.address,value:r.value})));
  assert.equal(hardware.plan.steppers[1].bothEdges,true);
  const y=hardware.plan.tmcUarts[0].devices.find(d=>d.stepper==='stepper_y')!;assert.equal(!!(y.registers.find(r=>r.name==='CHOPCONF')!.value&0x20000000),hardware.plan.steppers[1].bothEdges);
  const enables=f.firmware.outputs.filter(o=>o.name==='config_digital_out');assert.equal(enables.length,1);assert.equal(enables[0].parameters.value,1);assert.equal(enables[0].parameters.default_value,1);assert(!f.firmware.outputs.some(o=>o.name==='update_digital_out'&&o.parameters.value===0));
  await hardware.close();assert.equal(f.stops,1);
 }finally{await f.close();}
});
test('duplicate addresses and peripheral alias collisions are rejected without configuration I/O',async()=>{
 const f=await fixture();try{
  for(const change of [{uart_address:'0'},{uart_pin:'^PA0'},{select_pins:'PA6'}] as Record<string,string>[])assert.throws(()=>compileConfiguredHardware(reader(change),f.group,f.clocks,layout));
  const config=structuredClone(reader().source.original);delete config.stepper_x.enable_pin;assert.throws(()=>compileConfiguredHardware(new ConfigurationReader(new ConfigurationSource('/tmc.cfg',config,[]),null),f.group,f.clocks,layout),/controlled motor enable/);
  assert.equal(f.firmware.stepperConfigs.length,0);assert.equal(f.writes.length,0);
  const fixed=compileConfiguredHardware(reader(),f.group,f.clocks,layout);assert.equal(fixed.tmcUarts.length,1);assert.equal(fixed.tmcUarts[0].uart.oid,3);
 }finally{await f.close();}
});
test('failed driver initialization never publishes ready hardware and stops the MCU',async()=>{
 const f=await fixture(true);try{
  await assert.rejects(startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal),/Unable to read/);
  assert.equal(f.stops,1);assert.equal(f.group.status.state,'stopped');assert.equal(f.writes.length,0);assert(!f.firmware.outputs.some(o=>o.name==='update_digital_out'&&o.parameters.value===0));
 }finally{await f.close();}
});

test('runtime driver reset stops configured hardware and cancels all monitor timers',async()=>{
 const f=await fixture();try{
  const hardware=await startConfiguredHardware(reader(),f.group,f.clocks,layout,{beforeTarget(){}},f.signal);f.setFault(1);
  const deadline=Date.now()+3000;while(hardware.status.state==='ready'&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  await hardware.close();assert.equal(f.stops,1);assert.equal(hardware.status.state,'stopped');assert(hardware.drivers.every(d=>d.monitor.status.closed));assert(hardware.drivers.some(d=>d.monitor.status.fault));
  const frames=f.firmware.frames;await new Promise(r=>setTimeout(r,50));assert.equal(f.firmware.frames,frames);
 }finally{await f.close();}
});
