import {Max31865} from '../thermal/max31865.ts';
import {max31856Range} from '../thermal/max31856.ts';
import {max31855Range} from '../thermal/max31855.ts';
import {spiBusRequests} from './spi-bus.ts';
import type {TemperatureSink,SensorTimer} from '../thermal/serial-adc.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap,type PinRequest} from '../protocol/pins.ts';
import {compileSpi,compileSoftwareSpi} from '../protocol/spi-config.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {max6675Range,thermocoupleFormats} from '../thermal/max6675.ts';
import {SerialThermocouple} from '../thermal/serial-thermocouple.ts';
import {TemperatureSensorState} from '../thermal/temperature-sensor.ts';
import type {StepperMCU} from './stepper.ts';
import type {HeaterClock} from './analog-heater.ts';
import {readPrintClock} from '../timing/print-clock-timeline.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
const owners=new WeakSet<object>(),dictionaries=new WeakMap<object,object>();
export function compileConfiguredSpiSensors<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,clocks:ReadonlyMap<string,HeaterClock>,sections:readonly {section:string}[]){
 if(sections.length>192||new Set(sections.map(s=>s.section)).size!==sections.length)throw new Error('Invalid SPI temperature sensor batch');
 if(!sections.length)return Object.freeze([]);
 const requests:PinRequest[]=[],maps=new Map<string,PhysicalPinMap>(),buses=new Set<string>();
 const prepared=sections.map(({section})=>{
  const c=reader.section(section),model=c.get('sensor_type');if(model!=='MAX6675'&&model!=='MAX31855'&&model!=='MAX31856'&&model!=='MAX31865')throw new Error('Unsupported SPI temperature sensor');
  const rtd=model==='MAX31865'?new Max31865(c.getFloat('rtd_nominal_r',{defaultValue:100,above:0}),c.getFloat('rtd_reference_r',{defaultValue:430,above:0})):undefined;
  const rtdConfiguration=rtd?Object.freeze({wires:Number(c.getChoice('rtd_num_of_wires',{'2':2,'3':3,'4':4},{defaultValue:'2'})),filter:c.getBoolean('rtd_use_50hz_filter',{defaultValue:false})?1:0}):undefined;
  const minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),range=rtd?rtd.range(minimum,maximum):(model==='MAX31856'?max31856Range:model==='MAX31855'?max31855Range:max6675Range)(minimum,maximum),gcodeId=c.get('gcode_id',{defaultValue:null});
  if(gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  const description=c.get('sensor_pin'),cs=pins.parse(description),mcu=mcus.get(cs.chipName),mapping=clocks.get(cs.chipName);if(!mcu||mcu.chip!==cs.chip||!mapping?.timeline)throw new Error('SPI temperature MCU or timeline mismatch');
  if(model==='MAX31855'&&mcu.dictionary.constants.MAX31855_SIGNED_RANGE!==1)throw new Error('MAX31855 requires firmware signed-range capability');
  if(model==='MAX31856'&&mcu.dictionary.constants.MAX31856_SIGNED_RANGE!==1)throw new Error('MAX31856 requires firmware signed-range capability');
  const chipConfiguration=model==='MAX31856'?Object.freeze({filter:c.getBoolean('tc_use_50hz_filter',{defaultValue:false})?1:0,type:Number(c.getChoice('tc_type',{B:0,E:1,J:2,K:3,N:4,R:5,S:6,T:7},{defaultValue:'K'})),average:Number(c.getChoice('tc_averaging_count',{'1':0,'2':16,'4':32,'8':48,'16':112},{defaultValue:'1'}))}):undefined;
  const resolver=pins.resolver(cs.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  maps.set(cs.chipName,{pins:enumeration,reserved:resolver.physicalReservations(enumeration)});
  const resolvePin=(description:string)=>{const p=pins.parse(description);if(p.chip!==cs.chip)throw new Error('SPI pins must share the sensor MCU');return Object.freeze({...p,pin:resolver.resolve([`claim pin=${p.pin}`])[0].slice(10)});};
  const swNames=['spi_software_miso_pin','spi_software_mosi_pin','spi_software_sclk_pin'],software=swNames.some(k=>c.hasOption(k))?swNames.map(k=>resolvePin(c.get(k))):undefined;
  if(software&&c.hasOption('spi_bus'))throw new Error('SPI hardware and software buses are mutually exclusive');
  const bus=software?'software:'+software.map(p=>enumeration[p.pin]).join(','):c.get('spi_bus'),rate=c.getInt('spi_speed',{defaultValue:4000000,minval:100000,maxval:4300000});
  requests.push({description,exclusive:true});const key=cs.chipName+':'+bus;
  if(!buses.has(key)){requests.push(...spiBusRequests(pins,cs.chipName,mcu.dictionary,bus,software));buses.add(key);}
  const clock=readPrintClock(mapping.calibration,mapping.timeline),frequency=Number(mcu.dictionary.constant('CLOCK_FREQ')),reportTicks=Math.trunc(.3*frequency);
  if(!Number.isFinite(mapping.currentPrintTime)||mapping.currentPrintTime<0||!Number.isFinite(frequency)||frequency<=0||frequency>1e9||reportTicks<1||reportTicks>0x7fffffff)throw new Error('Invalid thermocouple timing');
  for(const format of Object.values(thermocoupleFormats))mcu.dictionary.lookup(format);
  return {section,rtd,rtdConfiguration,chipConfiguration,model:model as 'MAX6675'|'MAX31855'|'MAX31856'|'MAX31865',minimum,maximum,range,gcodeId:gcodeId??undefined,mcu:cs.chipName,chip:mcu.chip,dictionary:mcu.dictionary,cs:resolvePin(description),software,bus,rate,clock,timeline:mapping.timeline,currentPrintTime:mapping.currentPrintTime,frequency,reportTicks};
 });
 return mcuOids(pins).claim(prepared.flatMap(p=>[{mcu:p.mcu,owner:'temperature:'+p.section+':spi'},{mcu:p.mcu,owner:'temperature:'+p.section}]),oids=>{
  const plans=prepared.map((p,i)=>{
   const spi=p.software?compileSoftwareSpi(p.chip,p.dictionary,oids[i*2],p.cs,p.software,p.rate,p.model==='MAX31856'||p.model==='MAX31865'?1:0):compileSpi(p.chip,p.dictionary,oids[i*2],p.cs,p.bus,p.rate,p.model==='MAX31856'||p.model==='MAX31865'?1:0),oid=oids[i*2+1],initialClock=p.clock.clockAt(Math.trunc(p.currentPrintTime+1.5))+BigInt(Math.trunc(oid*.01*p.frequency));
   if(initialClock<0n||initialClock>=0x7fffffffffffffffn)throw new Error('Invalid thermocouple query clock');
   const commands=[`config_thermocouple oid=${oid} spi_oid=${spi.oid} thermocouple_type=${p.model}`],init=[`query_thermocouple oid=${oid} clock=${BigInt.asUintN(32,initialClock)} rest_ticks=${p.model==='MAX31856'||p.model==='MAX31865'?0:p.reportTicks} min_value=${p.range.minimum} max_value=${p.range.maximum} max_invalid_count=3`];
   for(const command of [...commands,...init])p.dictionary.encodeCommand(command);
   const plan=Object.freeze({...p,spi,oid,initialClock,commands:Object.freeze(commands),init:Object.freeze(init)});dictionaries.set(plan,p.dictionary);return plan;
  });
  pins.lookupBatch(requests,maps);return Object.freeze(plans);
 });
}
export function attachConfiguredSpiTemperature<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredSpiSensors<T>>[number],sink:TemperatureSink,timer?:SensorTimer){
 group.assertActive();const session=group.session(plan.mcu);if(owners.has(plan)||dictionaries.get(plan)!==session.dictionary)throw new Error('Invalid or reused SPI sensor plan');
 const sensor=new SerialThermocouple(session,plan,plan.timeline,sink,timer);owners.add(plan);return sensor;
}
export function attachConfiguredSpiSensor<T>(group:MCUGroup,plan:ReturnType<typeof compileConfiguredSpiSensors<T>>[number]){
 const state=new TemperatureSensorState(),sensor=attachConfiguredSpiTemperature(group,plan,{sample:(time,temp)=>state.sample(time,temp),shutdown:reason=>{state.shutdown(reason);void group.stop(new Error(reason)).catch(()=>{});}});
 return Object.freeze({section:plan.section,state,sensor});
}
