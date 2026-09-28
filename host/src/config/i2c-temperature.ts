import {Sht3xSensor} from '../thermal/sht3x.ts';
import {i2cTemperatureModel} from '../thermal/i2c-temperature-model.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap,type PinRequest} from '../protocol/pins.ts';
import {compileI2c,compileSoftwareI2c} from '../protocol/i2c-config.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import {readI2cTemperature,I2cTemperatureRuntime} from '../thermal/i2c-temperature-runtime.ts';
import {AhtSensor,type AhtModel} from '../thermal/aht.ts';
import {sessionI2c} from '../drivers/i2c-mcu.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
const dictionaries=new WeakMap<object,object>(),owners=new WeakSet<object>();
export function compileConfiguredI2cSensors<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,sections:readonly {section:string}[]){
 if(sections.length>128||new Set(sections.map(s=>s.section)).size!==sections.length||new Set(sections.map(s=>s.section.trim().split(/\s+/).at(-1))).size!==sections.length)throw new Error('Invalid I2C temperature sensor batch');
 if(!sections.length)return Object.freeze([]);
 const requests:PinRequest[]=[],maps=new Map<string,PhysicalPinMap>(),addresses=new Set<string>();
 const prepared=sections.map(({section})=>{
  const config=readI2cTemperature(reader,section),c=reader.section(section),mcu=c.get('i2c_mcu',{defaultValue:'mcu'}),device=mcus.get(mcu);if(!device)throw new Error('Unknown I2C temperature MCU');
  const dictionary=device.dictionary,enumeration=dictionary.pinEnumeration,resolver=pins.resolver(mcu).clone();
  for(const [name,value] of Object.entries(dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid I2C pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  maps.set(mcu,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const names=['i2c_software_scl_pin','i2c_software_sda_pin'],software=names.some(k=>c.hasOption(k))?names.map(k=>{const p=pins.parse(c.get(k));if(p.chip!==device.chip||p.invert||p.pullup)throw new Error('I2C pins must share sensor MCU without polarity flags');return Object.freeze({...p,pin:resolver.resolve([`claim pin=${p.pin}`])[0].slice(10)});}):undefined;
  if(software&&c.hasOption('i2c_bus'))throw new Error('I2C hardware and software buses are mutually exclusive');
  const bus=software?'software':c.get('i2c_bus'),rate=c.getInt('i2c_speed',{defaultValue:100000,minval:100000,maxval:0xffffffff}),address=c.getInt('i2c_address',{defaultValue:i2cTemperatureModel(config.model).address,minval:0,maxval:127});
  const raw=software?software.map(p=>p.pin):(()=>{const metadata=dictionary.constant('BUS_PINS_'+bus);if(typeof metadata!=='string')throw new Error('Missing I2C bus pin metadata');return metadata.split(',').map(p=>p.trim());})();
  const physical=raw.map(p=>resolver.resolve([`claim pin=${p}`])[0].slice(10)),ids=physical.map(p=>enumeration[p]);
  if(raw.length!==2||ids.some(id=>id===undefined)||ids[0]===ids[1]||!software&&raw.some((p,i)=>enumeration[p]!==ids[i]))throw new Error('Invalid I2C bus physical wiring');
  const backend=software?'software':Buffer.from(dictionary.encodeCommand(`i2c_set_bus oid=0 i2c_bus=${bus} rate=${rate} address=0`)).toString('hex');
  const identity=JSON.stringify([mcu,backend,ids,rate]),addressKey=JSON.stringify([mcu,[...ids].sort((a,b)=>a-b),address]);
  if(addresses.has(addressKey))throw new Error('Duplicate I2C device address');addresses.add(addressKey);
  physical.forEach((p,i)=>requests.push({description:mcu+':'+p,options:{shareType:'i2c:'+identity+':'+i},strictSharing:true}));
  return {...config,mcu,chip:device.chip,dictionary,software,bus,rate,address};
 });
 return mcuOids(pins).claim(prepared.map(p=>({mcu:p.mcu,owner:'i2c-temperature:'+p.section})),oids=>{
  const plans=prepared.map((p,i)=>{const protocol=p.software?compileSoftwareI2c(p.chip,p.dictionary,oids[i],p.address,p.software[0],p.software[1],p.rate):compileI2c(p.dictionary,oids[i],p.address,p.bus,p.rate),plan=Object.freeze({...p,protocol});dictionaries.set(plan,p.dictionary);return plan;});
  pins.lookupBatch(requests,maps);return Object.freeze(plans);
 });
}
export function attachConfiguredI2cSensor<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredI2cSensors<T>>[number],fault:(cause:unknown)=>void){
 group.assertActive();const session=group.session(plan.mcu);if(owners.has(plan)||dictionaries.get(plan)!==session.dictionary)throw new Error('Invalid or reused I2C temperature sensor plan');
 // Register the owner before configuration; allocate its FIFO only when
 // startup sampling begins after every MCU has finalized configuration.
 const sensor=new I2cTemperatureRuntime(plan,plan.model==='SHT3X'?new Sht3xSensor({transfer:(bytes,n,signal)=>sessionI2c(session,plan.protocol.oid).transfer(bytes,n,signal)}):new AhtSensor({transfer:(bytes,n,signal)=>sessionI2c(session,plan.protocol.oid).transfer(bytes,n,signal)},plan.model as AhtModel),fault);owners.add(plan);return sensor;
}
