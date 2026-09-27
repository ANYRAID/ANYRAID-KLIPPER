import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import {compileTmcUart} from '../drivers/tmc-uart-mcu.ts';
import {planTmc220x} from '../drivers/tmc220x.ts';
/** All drivers on a physical UART are allocated together. The parent hardware
 * assembly owns rollback across other peripheral builders. No device I/O. */
export function compileConfiguredTmcUart<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,steppers:readonly {section:string;bothEdges:boolean}[]){
 const sections=reader.sections().filter(s=>/^tmc\d+ /.test(s)&&!/^tmc(2130|5160) /.test(s));
 if(sections.length>128)throw new Error('Too many TMC drivers');
 const maps=new Map<string,PhysicalPinMap>(),buses=new Map<string,{mcu:string;rx:ReturnType<typeof pins.parse>;tx:ReturnType<typeof pins.parse>;descriptions:string[];devices:ReturnType<typeof planTmc220x>[]} >(),motors=new Set<string>();
 for(const section of sections){
  if(!/^tmc220[89] /.test(section))throw new Error('Unsupported native TMC model: '+section);
  const c=reader.section(section),model=planTmc220x(reader,section),stepper=steppers.find(s=>s.section===model.stepper);
  if(!stepper||motors.has(model.stepper))throw new Error('Missing or duplicate TMC stepper owner');motors.add(model.stepper);
  if(!reader.section(model.stepper).hasOption('enable_pin'))throw new Error('TMC startup requires a controlled motor enable');
  if(c.hasOption('select_pins'))throw new Error('TMC UART mux is not yet supported');
  const rxDescription=c.get('uart_pin'),txDescription=c.get('tx_pin',{defaultValue:rxDescription}),rx=pins.parse(rxDescription,{canPullup:true}),tx=txDescription===rxDescription?rx:pins.parse(txDescription);
  if(rx.chip!==tx.chip)throw new Error('TMC RX/TX must share an MCU');const mcu=mcus.get(rx.chipName);if(!mcu||mcu.chip!==rx.chip)throw new Error('TMC MCU ownership mismatch');
  const resolver=pins.resolver(rx.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const pin of value.split(','))if(pin.trim())resolver.reserve(pin.trim(),name.slice(13));}
  const resolve=(pin:typeof rx)=>{const name=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10);if(enumeration[name]===undefined)throw new Error('Unknown TMC pin');return Object.freeze({...pin,pin:name});};
  const resolvedRx=resolve(rx),resolvedTx=rx===tx?resolvedRx:resolve(tx),key=rx.chipName+':'+enumeration[resolvedRx.pin],old=buses.get(key);
  maps.set(rx.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const configured=stepper.bothEdges?Object.freeze({...model,registers:Object.freeze(model.registers.map(r=>r.name==='CHOPCONF'?Object.freeze({...r,value:(r.value|0x20000000)>>>0}):r))}):model;
  if(old){if(enumeration[old.tx.pin]!==enumeration[resolvedTx.pin]||old.rx.pullup!==resolvedRx.pullup||old.devices.some(d=>d.address===model.address))throw new Error('Shared TMC UART pins or address conflict');old.devices.push(configured);}
  else buses.set(key,{mcu:rx.chipName,rx:resolvedRx,tx:resolvedTx,descriptions:enumeration[resolvedRx.pin]===enumeration[resolvedTx.pin]?[rxDescription]:[rxDescription,txDescription],devices:[configured]});
 }
 const entries=[...buses.values()];if(!entries.length)return Object.freeze([]);
 return mcuOids(pins).claim(entries.map(b=>({mcu:b.mcu,owner:'tmc_uart:'+b.rx.pin})),oids=>{
  const plans=entries.map((b,i)=>Object.freeze({mcu:b.mcu,uart:compileTmcUart(mcus.get(b.mcu)!.chip,mcus.get(b.mcu)!.dictionary,oids[i],b.rx,b.tx),devices:Object.freeze(b.devices)}));
  pins.lookupBatch(entries.flatMap(b=>b.descriptions.map((description,i)=>({description,options:{canPullup:i===0},exclusive:true}))),maps);return Object.freeze(plans);
 });
}
