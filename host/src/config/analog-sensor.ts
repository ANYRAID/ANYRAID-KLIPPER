import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {AnalogSensorRegistry} from '../thermal/sensor-config.ts';
import {ADCTemperature} from '../thermal/adc.ts';
import {TemperatureSensorState} from '../thermal/temperature-sensor.ts';
import {SerialADCTemperature} from '../thermal/serial-adc.ts';
import {compileADC} from '../inputs/adc.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import type {StepperMCU} from './stepper.ts';
import type {HeaterClock} from './analog-heater.ts';
import {MCUGroup} from '../runtime/mcu-group.ts';
const owners=new WeakSet<object>(),dictionaries=new WeakMap<object,object>();
/** Independent ADC input with no heater output or target authority. */
export function compileConfiguredAnalogSensors<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,HeaterClock>,requests:readonly {section:string}[]){
 if(requests.length>128||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid analog sensor batch');
 if(!requests.length)return Object.freeze([]);
 const registry=new AnalogSensorRegistry(reader),maps=new Map<string,PhysicalPinMap>();
 const prepared=requests.map(({section})=>{
  const c=reader.section(section),minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),converter=registry.create(c),sampling=new ADCTemperature(converter,minimum,maximum,()=>{},()=>{}).sampling;
  const gcodeId=c.get('gcode_id',{defaultValue:null});if(gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  const description=c.get('sensor_pin'),pin=pins.parse(description),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('Analog sensor MCU or clock ownership differs');
  const resolver=pins.resolver(pin.chipName).clone();for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  maps.set(pin.chipName,{pins:mcu.dictionary.pinEnumeration,reserved:resolver.physicalReservations(mcu.dictionary.pinEnumeration)});
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),clock=readPrintClock(mapping.calibration,mapping.timeline);
  return {section,minimum,maximum,converter,sampling,gcodeId:gcodeId??undefined,description,pin:Object.freeze({...pin,pin:resolved}),mcu,clock,timeline:mapping.timeline,currentPrintTime:mapping.currentPrintTime};
 });
 return mcuOids(pins).claim(prepared.map(p=>({mcu:p.pin.chipName,owner:p.section})),oids=>{
  const plans=prepared.map((p,i)=>{const adc=compileADC(p.mcu.chip,p.mcu.dictionary,{oid:oids[i],pin:p.pin,currentPrintTime:p.currentPrintTime,...p.sampling},p.clock.clockAt);for(const command of [...adc.commands,...adc.init])p.mcu.dictionary.encodeCommand(command);return adc;});
  const acquired=pins.lookupBatch(prepared.map(p=>({description:p.description,exclusive:true})),maps);
  return Object.freeze(prepared.map((p,i)=>{const plan=Object.freeze({...p,mcu:p.pin.chipName,chip:p.mcu.chip,pin:acquired[i],adc:plans[i]});dictionaries.set(plan,p.mcu.dictionary);return plan;}));
 });
}
export function attachConfiguredAnalogSensor<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredAnalogSensors<T>>[number]){
 group.assertActive();const session=group.session(plan.mcu);if(owners.has(plan)||dictionaries.get(plan)!==session.dictionary)throw new Error('Invalid or reused analog sensor plan');
 const state=new TemperatureSensorState(),sensor=new SerialADCTemperature(session,plan.chip,{oid:plan.adc.oid,pin:plan.pin,currentPrintTime:plan.currentPrintTime,minimum:plan.minimum,maximum:plan.maximum},plan.converter,plan.clock.clockAt,plan.clock.printTimeAtClock,{sample:(time,temp)=>state.sample(time,temp),shutdown:reason=>{state.shutdown(reason);void group.stop(new Error(reason)).catch(()=>{});}},undefined,plan.timeline);
 owners.add(plan);return Object.freeze({section:plan.section,state,sensor});
}
