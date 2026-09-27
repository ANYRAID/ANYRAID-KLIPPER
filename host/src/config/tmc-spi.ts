import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap,type PinRequest} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import {compileTmcSpi} from '../drivers/tmc-spi-mcu.ts';
import {planTmc2130} from '../drivers/tmc2130.ts';
/** One OID per CS chain. Hardware bus pins are exclusively claimed once across
 * all CS chains, with firmware BUS_PINS metadata required for conflict checks. */
export function compileConfiguredTmcSpi<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,steppers:readonly {section:string;bothEdges:boolean}[]){
 const maps=new Map<string,PhysicalPinMap>(),requests:PinRequest[]=[],usedBuses=new Set<string>();
 const chains=new Map<string,{mcu:string;cs:ReturnType<typeof pins.parse>;bus:string;rate:number;length:number;devices:{position:number;plan:ReturnType<typeof planTmc2130>}[]}>();
 for(const section of reader.sections().filter(s=>s.startsWith('tmc2130 '))){
  const c=reader.section(section),base=planTmc2130(reader,section),stepper=steppers.find(s=>s.section===base.stepper);
  if(!stepper||!reader.section(base.stepper).hasOption('enable_pin'))throw new Error('TMC SPI requires a controlled stepper enable');
  if(['spi_software_sclk_pin','spi_software_miso_pin','spi_software_mosi_pin'].some(k=>c.hasOption(k)))throw new Error('Native TMC software SPI is not yet supported');
  const description=c.get('cs_pin'),cs=pins.parse(description),mcu=mcus.get(cs.chipName);if(!mcu||mcu.chip!==cs.chip)throw new Error('TMC SPI MCU mismatch');
  const resolver=pins.resolver(cs.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${cs.pin}`])[0].slice(10);if(enumeration[resolved]===undefined)throw new Error('Unknown SPI CS pin');
  maps.set(cs.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const bus=c.get('spi_bus'),rate=c.getInt('spi_speed',{defaultValue:4000000,minval:100000,maxval:0xffffffff}),length=c.getInt('chain_length',{defaultValue:1,minval:c.hasOption('chain_length')?2:1,maxval:10}),position=c.getInt('chain_position',{defaultValue:length===1?1:undefined,minval:1,maxval:length});
  const key=cs.chipName+':'+enumeration[resolved],old=chains.get(key);
  const plan=stepper.bothEdges?Object.freeze({...base,registers:Object.freeze(base.registers.map(r=>r.name==='CHOPCONF'?Object.freeze({...r,value:(r.value|0x20000000)>>>0}):r))}):base;
  if(old){if(old.bus!==bus||old.rate!==rate||old.length!==length||old.devices.some(d=>d.position===position))throw new Error('Conflicting TMC SPI chain configuration');old.devices.push({position,plan});}
  else{chains.set(key,{mcu:cs.chipName,cs:Object.freeze({...cs,pin:resolved}),bus,rate,length,devices:[{position,plan}]});requests.push({description,exclusive:true});}
  const busKey=cs.chipName+':'+bus;if(!usedBuses.has(busKey)){
   const constant=mcu.dictionary.constant('BUS_PINS_'+bus);if(typeof constant!=='string'||constant.split(',').length!==3)throw new Error('TMC SPI requires three firmware bus pins');
   for(const name of constant.split(','))requests.push({description:cs.chipName+':'+name.trim(),exclusive:true});usedBuses.add(busKey);
  }
 }
 const entries=[...chains.values()];if(!entries.length)return Object.freeze([]);
 return mcuOids(pins).claim(entries.map(b=>({mcu:b.mcu,owner:'tmc_spi:'+b.cs.pin})),oids=>{
  const plans=entries.map((b,i)=>Object.freeze({mcu:b.mcu,spi:compileTmcSpi(mcus.get(b.mcu)!.chip,mcus.get(b.mcu)!.dictionary,oids[i],b.cs,b.bus,b.rate),length:b.length,devices:Object.freeze(b.devices.map(d=>Object.freeze(d)))}));
  pins.lookupBatch(requests,maps);return Object.freeze(plans);
 });
}
