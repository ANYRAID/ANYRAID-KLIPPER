import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readHeaterControlConfiguration} from '../thermal/heater-config.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {compilePWM} from '../outputs/pwm.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import type {StepperMCU} from './stepper.ts';
import type {HeaterClock} from './analog-heater.ts';
import {createHeaterOutputRuntime} from './heater-output.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
import type {ThermalTimer} from '../thermal/runtime.ts';
const owners=new WeakSet<object>(),dictionaries=new WeakMap<object,object>();
/** Output-only plan shared by combined and AHT sensors. Input validation and
 * sampling are owned by the configured hardware lifecycle. */
export function compileConfiguredCombinedHeaters<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,HeaterClock>,sections:readonly string[]){
 if(sections.length>64||new Set(sections).size!==sections.length)throw new Error('Invalid Combined heater batch');
 if(!sections.length)return Object.freeze([]);
 const maps=new Map<string,PhysicalPinMap>();
 const prepared=sections.map(section=>{
  const configuration=readHeaterControlConfiguration(reader,section),description=reader.section(section).get('heater_pin'),pin=pins.parse(description,{canInvert:true}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);
  if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('Combined heater output MCU or clock differs');
  const resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  maps.set(pin.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10);
  return {section,configuration,description,pin:Object.freeze({...pin,pin:resolved}),mcu,mapping,clock:readPrintClock(mapping.calibration,mapping.timeline)};
 });
 return mcuOids(pins).claim(prepared.map(p=>({mcu:p.pin.chipName,owner:'heater:'+p.section+':pwm'})),oids=>{
  const outputs=prepared.map((p,i)=>{
   const pwm=compilePWM(p.mcu.chip,p.mcu.dictionary,{oid:oids[i],pin:p.pin,hardware:false,cycleTime:p.configuration.pwmCycleTime,maxDuration:3,start:0,shutdown:0,currentPrintTime:p.mapping.currentPrintTime},p.clock.clockAt);
   for(const cmd of [...pwm.commands,...pwm.restart,...pwm.init])p.mcu.dictionary.encodeCommand(cmd);
   p.mcu.dictionary.lookup('reset_digital_out_generation oid=%c generation=%u');p.mcu.dictionary.lookup('queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');return pwm;
  });
  const acquired=pins.lookupBatch(prepared.map(p=>({description:p.description,options:{canInvert:true},exclusive:true})),maps);
  return Object.freeze(prepared.map((p,i)=>{const plan=Object.freeze({section:p.section,configuration:p.configuration,output:Object.freeze({mcu:p.pin.chipName,pin:acquired[i],pwm:outputs[i],clock:p.clock,timeline:p.mapping.timeline})});dictionaries.set(plan,p.mcu.dictionary);return plan;}));
 });
}
export function attachConfiguredCombinedHeater<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredCombinedHeaters<T>>[number],timer?:ThermalTimer){
 group.assertActive();if(owners.has(plan)||dictionaries.get(plan)!==group.session(plan.output.mcu).dictionary)throw new Error('Invalid or reused combined heater plan');
 const binding=createHeaterOutputRuntime(group,plan.output,plan.configuration,plan.output.mcu,timer);owners.add(plan);return binding;
}
