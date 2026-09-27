import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import type {FanClock} from './cooling-fan.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import {compileButtons} from '../inputs/buttons.ts';
/** One independent switch per OID. Uses the same global physical pin registry
 * as heaters, motors and fans; failed batches publish no pin/OID claims. */
export function compileConfiguredButtons<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,FanClock>,requests:readonly {section:string}[]){
 if(!requests.length||requests.length>64||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid switch input batch');
 const maps=new Map<string,PhysicalPinMap>();
 const inputs=requests.map(({section})=>{
  const description=reader.section(section).get('switch_pin'),pin=pins.parse(description,{canInvert:true,canPullup:true}),mcu=mcus.get(pin.chipName),mapping=clocks.get(pin.chipName);
  if(!mcu||mcu.chip!==pin.chip||!mapping)throw new Error('Switch MCU or clock ownership differs');
  const clock=readPrintClock(mapping.calibration,mapping.timeline),resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),reserved=resolver.physicalReservations(enumeration);maps.set(pin.chipName,{pins:enumeration,reserved});
  return {section,description,pin:Object.freeze({...pin,pin:resolved}),mcu,clock,timeline:mapping.timeline,currentPrintTime:mapping.currentPrintTime};
 });
 return mcuOids(pins).claim(inputs.map(i=>({mcu:i.pin.chipName,owner:'switch:'+i.section})),oids=>{
  const plans=inputs.map((i,index)=>compileButtons(i.mcu.chip,i.mcu.dictionary,{oid:oids[index],pins:[i.pin],currentPrintTime:i.currentPrintTime},i.clock.clockAt));
  const acquired=pins.lookupBatch(inputs.map(i=>({description:i.description,options:{canInvert:true,canPullup:true},exclusive:true})),maps);
  return Object.freeze(inputs.map((i,index)=>Object.freeze({section:i.section,mcu:i.pin.chipName,pin:acquired[index],buttons:plans[index],timeline:i.timeline})));
 });
}
