import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readHeaterControlConfiguration} from '../thermal/heater-config.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {compilePWM} from '../outputs/pwm.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import type {StepperMCU} from './stepper.ts';
import type {HeaterClock} from './analog-heater.ts';
import {attachConfiguredSpiTemperature,type compileConfiguredSpiSensors} from './spi-temperature.ts';
import {createHeaterOutputRuntime} from './heater-output.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
import type {SensorTimer} from '../thermal/serial-adc.ts';
import type {ThermalTimer} from '../thermal/runtime.ts';
const owners=new WeakSet<object>(),dictionaries=new WeakMap<object,object>();
/** Sensor plans are compiled together with independent SPI inputs so each bus
 * is claimed once. Hardware assembly keeps all intermediate claims private. */
export function compileConfiguredSpiHeaters<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,HeaterClock>,sensors:ReturnType<typeof compileConfiguredSpiSensors<T>>){
 if(sensors.length>64||new Set(sensors.map(s=>s.section)).size!==sensors.length)throw new Error('Invalid SPI heater batch');
 if(!sensors.length)return Object.freeze([]);
 const maps=new Map<string,PhysicalPinMap>();
 const prepared=sensors.map(sensor=>{
  const configuration=readHeaterControlConfiguration(reader,sensor.section),description=reader.section(sensor.section).get('heater_pin'),pin=pins.parse(description,{canInvert:true}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);
  if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('SPI heater output MCU or clock differs');
  if(sensor.model==='MAX6675'&&(configuration.settings.minimum<0||configuration.settings.maximum>1023.75))throw new Error('MAX6675 heater range exceeds sensor capability');
  if(configuration.settings.minimum!==sensor.minimum||configuration.settings.maximum!==sensor.maximum)throw new Error('SPI heater and sensor ranges differ');
  const resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  maps.set(pin.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10);
  return {sensor,configuration,description,pin:Object.freeze({...pin,pin:resolved}),mcu,mapping,clock:readPrintClock(mapping.calibration,mapping.timeline)};
 });
 return mcuOids(pins).claim(prepared.map(p=>({mcu:p.pin.chipName,owner:'heater:'+p.sensor.section+':pwm'})),oids=>{
  const outputs=prepared.map((p,i)=>{
   const pwm=compilePWM(p.mcu.chip,p.mcu.dictionary,{oid:oids[i],pin:p.pin,hardware:false,cycleTime:p.configuration.pwmCycleTime,maxDuration:3,start:0,shutdown:0,currentPrintTime:p.mapping.currentPrintTime},p.clock.clockAt);
   for(const cmd of [...pwm.commands,...pwm.restart,...pwm.init])p.mcu.dictionary.encodeCommand(cmd);
   p.mcu.dictionary.lookup('reset_digital_out_generation oid=%c generation=%u');p.mcu.dictionary.lookup('queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');return pwm;
  });
  const acquired=pins.lookupBatch(prepared.map(p=>({description:p.description,options:{canInvert:true},exclusive:true})),maps);
  return Object.freeze(prepared.map((p,i)=>{const plan=Object.freeze({section:p.sensor.section,configuration:p.configuration,sensor:p.sensor,output:Object.freeze({mcu:p.pin.chipName,pin:acquired[i],pwm:outputs[i],clock:p.clock,timeline:p.mapping.timeline})});dictionaries.set(plan,p.mcu.dictionary);return plan;}));
 });
}
export function attachConfiguredSpiHeater<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredSpiHeaters<T>>[number],timers:{sensor?:SensorTimer;thermal?:ThermalTimer}={}){
 group.assertActive();if(owners.has(plan)||dictionaries.get(plan)!==group.session(plan.output.mcu).dictionary)throw new Error('Invalid or reused SPI heater plan');
 const binding=createHeaterOutputRuntime(group,plan.output,plan.configuration,plan.sensor.mcu,timers.thermal),runtime=binding.runtime;
 const sensor=attachConfiguredSpiTemperature(group,plan.sensor,{sample:(time,temp)=>runtime.sample(time,temp),shutdown:reason=>{void runtime.shutdown(reason).catch(()=>{});}},timers.sensor);
 owners.add(plan);return Object.freeze({runtime,sensor,get outputStatus(){return binding.outputStatus;},async start(signal:AbortSignal){try{await runtime.start(signal);sensor.activate();}catch(error){try{await group.stop(error);}catch(stop){throw new AggregateError([error,stop],'SPI heater startup and stop failed');}throw error;}},stop:(cause?:unknown)=>runtime.shutdown(cause)});
}
