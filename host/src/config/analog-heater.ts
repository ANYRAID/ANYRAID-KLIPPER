// Analog heater resource assembly. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readHeaterConfiguration} from '../thermal/heater-config.ts';
import {AnalogSensorRegistry} from '../thermal/sensor-config.ts';
import {ADCTemperature} from '../thermal/adc.ts';
import {compileADC} from '../inputs/adc.ts';
import {compilePWM} from '../outputs/pwm.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
import type {StepperMCU} from './stepper.ts';
import type {MessageDictionary} from '../protocol/dictionary.ts';
import {MCUGroup} from '../runtime/mcu-group.ts';
import {GenerationPWMOutput} from '../outputs/generation-pwm.ts';
import {AsyncHeaterRuntime} from '../thermal/async-runtime.ts';
import {SerialADCTemperature,type SensorTimer} from '../thermal/serial-adc.ts';
import type {ThermalTimer} from '../thermal/runtime.ts';
import {serialClock} from '../protocol/serial-queue.ts';
const dictionaries=new WeakMap<object,{output:MessageDictionary;sensor:MessageDictionary}>(),owners=new WeakSet<object>();
export interface AnalogHeaterRequest {section:string;pwmOid?:number;adcOid?:number}
export interface HeaterClock {currentPrintTime:number;calibration:Readonly<{offset:number;frequency:number}>}
/** Pure planning: subscribe the sensor before MCU init, then construct/start
 * the output runtime after configuration and activate its buffered sensor. */
export function compileConfiguredAnalogHeaters<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,HeaterClock>,requests:readonly AnalogHeaterRequest[]){
 if(!requests.length||requests.length>64||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid analog heater batch');
 const registry=new AnalogSensorRegistry(reader),maps=new Map<string,PhysicalPinMap>();
 const heaters=requests.map(request=>({request,configuration:readHeaterConfiguration(reader,request.section,registry)}));
 const outputs=heaters.flatMap(h=>(['pwm','adc'] as const).map(role=>{
  const description=reader.section(h.request.section).get(role==='pwm'?'heater_pin':'sensor_pin'),pin=pins.parse(description,{canInvert:role==='pwm'}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);
  if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('Analog heater MCU or clock ownership differs');
  const clock=snapshotPrintClock(mapping.calibration),resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),reserved=resolver.physicalReservations(enumeration);maps.set(pin.chipName,{pins:enumeration,reserved});
  return {description,pin:Object.freeze({...pin,pin:resolved}),mcu,clock,currentPrintTime:mapping.currentPrintTime,oid:role==='pwm'?h.request.pwmOid:h.request.adcOid,owner:`heater:${h.request.section}:${role}`};
 }));
 return mcuOids(pins).claim(outputs.map(o=>({mcu:o.pin.chipName,owner:o.owner,oid:o.oid})),oids=>{
  const plans=heaters.map((h,i)=>{
   const power=outputs[2*i],sensor=outputs[2*i+1],c=h.configuration,limits=new ADCTemperature(c.converter,c.settings.minimum,c.settings.maximum,()=>{},()=>{}).sampling;
   const pwm=compilePWM(power.mcu.chip,power.mcu.dictionary,{oid:oids[2*i],pin:power.pin,hardware:false,cycleTime:c.pwmCycleTime,maxDuration:3,start:0,shutdown:0,currentPrintTime:power.currentPrintTime},power.clock.clockAt);
   const adc=compileADC(sensor.mcu.chip,sensor.mcu.dictionary,{oid:oids[2*i+1],pin:sensor.pin,currentPrintTime:sensor.currentPrintTime,...limits},sensor.clock.clockAt);
   for(const command of [...pwm.commands,...pwm.restart,...pwm.init])power.mcu.dictionary.encodeCommand(command);
   for(const command of [...adc.commands,...adc.init])sensor.mcu.dictionary.encodeCommand(command);
   power.mcu.dictionary.lookup('reset_digital_out_generation oid=%c generation=%u');power.mcu.dictionary.lookup('queue_digital_out_generation oid=%c clock=%u on_ticks=%u generation=%u');
   return {section:h.request.section,configuration:c,pwm,adc};
  });
  const acquired=pins.lookupBatch(outputs.map((o,i)=>({description:o.description,options:{canInvert:i%2===0},exclusive:true})),maps);
  return Object.freeze(plans.map((p,i)=>{const power=outputs[2*i],sensor=outputs[2*i+1],plan=Object.freeze({section:p.section,configuration:p.configuration,output:Object.freeze({mcu:power.pin.chipName,pin:acquired[2*i],clock:power.clock,pwm:p.pwm}),sensor:Object.freeze({mcu:sensor.pin.chipName,chip:sensor.mcu.chip,pin:acquired[2*i+1],clock:sensor.clock,currentPrintTime:sensor.currentPrintTime,adc:p.adc})});dictionaries.set(plan,{output:power.mcu.dictionary,sensor:sensor.mcu.dictionary});return plan;}));
 });
}
/** Subscribe before MCU init. Runtime reset lazily acquires output queues only
 * after configuration; start then activates buffered ADC samples. Single-use. */
export function attachConfiguredAnalogHeater<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredAnalogHeaters<T>>[number],timers:{sensor?:SensorTimer;thermal?:ThermalTimer}={}){
 group.assertActive();const expected=dictionaries.get(plan),outputSession=group.session(plan.output.mcu),sensorSession=group.session(plan.sensor.mcu);
 if(!expected||owners.has(plan)||expected.output!==outputSession.dictionary||expected.sensor!==sensorSession.dictionary)throw new Error('Invalid or reused analog heater plan ownership');
 const p=plan.output,c=plan.configuration;let output:GenerationPWMOutput|undefined;
 const runtime=new AsyncHeaterRuntime(c.settings,c.control,{
  configuration:{cycleTime:p.pwm.cycleTime,maximumDuration:p.pwm.maximumDuration,initialPower:p.pwm.invert?1-p.pwm.startValue:p.pwm.startValue,defaultPower:p.pwm.invert?1-p.pwm.shutdownValue:p.pwm.shutdownValue},
  reset(signal){group.assertActive();outputSession.configuration;sensorSession.configuration;output??=new GenerationPWMOutput(p.pwm,outputSession.dictionary,group.commandQueue(p.mcu),group.commandQueue(p.mcu),p.clock.clockAt,p.clock.printTimeAtClock);return output.reset(signal);},
  setPWM(time,power,signal){if(!output)throw new Error('Heater output not started');return output.setPWM(time,power,signal);},
  stop(cause){return output?output.stop(cause):group.stop(cause);},
 },()=>{const system=serialClock.now();return {system,print:p.clock.printTimeAtClock(outputSession.clock.sync.getClock(system))};},c.verification,timers.thermal);
 const sensor=new SerialADCTemperature(sensorSession,plan.sensor.chip,{oid:plan.sensor.adc.oid,pin:plan.sensor.pin,currentPrintTime:plan.sensor.currentPrintTime,minimum:c.settings.minimum,maximum:c.settings.maximum},c.converter,plan.sensor.clock.clockAt,plan.sensor.clock.printTimeAtClock,{sample:(time,temp)=>runtime.sample(time,temp),shutdown:reason=>{void runtime.shutdown(reason).catch(()=>{});}},timers.sensor);
 owners.add(plan);
 return Object.freeze({runtime,sensor,get outputStatus(){return output?.status;},async start(signal:AbortSignal){try{await runtime.start(signal);sensor.activate();}catch(error){try{await group.stop(error);}catch(stop){throw new AggregateError([error,stop],'Analog heater startup and stop failed');}throw error;}},stop:(cause?:unknown)=>runtime.shutdown(cause)});
}
