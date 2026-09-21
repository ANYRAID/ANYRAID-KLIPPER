// Moonraker sensor.py configuration semantics. GPL-3.0-or-later.
// Original Copyright (C) 2022 Morton Jonuschat.
import {ConfigurationReader,parseConfigurationInteger} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import {SensorStore,type SensorOptions,type SensorHistoryField} from './sensors.ts';
import {HistoryFields} from './history-fields.ts';
export interface SensorSourceConfiguration {sensor:SensorOptions;mqtt:{topic:string;template:string;qos:number|null};}
/** Consumes configuration only; template compilation and MQTT ownership belong
 * to the source adapter. Never infer a live connection from a parsed plan. */
export function readSensorConfiguration(reader:ConfigurationReader):SensorSourceConfiguration[]{
 const sections=reader.prefixSections('sensor ');if(sections.length>32)throw new ConfigurationError('Sensor count exceeds configured limit');
 const identifiers=new Set<string>();
 return sections.map(name=>{
  const section=reader.section(name);
  try{
   const id=name.replace(/^sensor\s+/u,'');if(!id||identifiers.has(id))throw new ConfigurationError('Invalid or duplicate sensor identifier');identifiers.add(id);
   const type=section.get('type');if(type.toUpperCase()!=='MQTT')throw new ConfigurationError('Unsupported sensor type');
   const sensor:SensorOptions={id,type,name:section.get('name',{defaultValue:id}),historyProvider:name,capacity:section.getInt('sensor_store_size',{defaultValue:1200,minval:0,maxval:100000}),parameters:[],history:[]};
   for(const option of Object.keys(section.options())){
    if(option.startsWith('parameter_')){const data=section.getDictionary(option) as Record<string,string>;sensor.parameters!.push({...data,name:option.slice(10)});continue;}
    if(!option.startsWith('history_field_'))continue;
    const data=section.getDictionary(option) as Record<string,string>;
    if(!Object.hasOwn(data,'parameter'))throw new ConfigurationError(`Option '${option}' requires parameter`);
    const field:SensorHistoryField={name:option.slice(14),parameter:data.parameter,description:data.desc??`${data.parameter} tracker`,strategy:data.strategy??'basic',units:data.units??null,precision:data.precision===undefined?null:parseConfigurationInteger(data.precision),initTracker:data.init_tracker?.toLowerCase()==='true',excludePaused:data.exclude_paused?.toLowerCase()==='true',reportTotal:data.report_total?.toLowerCase()==='true',reportMaximum:data.report_maximum?.toLowerCase()==='true'};
    const known=new Set(['parameter','desc','strategy','units','precision','init_tracker','exclude_paused','report_total','report_maximum']);
    for(const key of Object.keys(data))if(!known.has(key))reader.warn(`[${name}]: Option '${option}' contains invalid key '${key}'`);
    sensor.history!.push(field);
   }
   const mqtt={topic:section.get('state_topic'),template:section.get('state_response_template'),qos:section.getInt('qos',{defaultValue:null,minval:0,maxval:2})};
   // Validate storage/field constraints without publishing partial registrations.
   const validation=new SensorStore();validation.register(sensor,new HistoryFields(()=>false));validation.close();
   return {sensor,mqtt};
  }catch(error){reader.error(name);throw new ConfigurationError(`[${name}]: Invalid sensor configuration`,{cause:error});}
 });
}
/** Build a new owned generation; failures never mutate an existing store or
 * registry. The caller supplies the history runtime's per-instance gate. */
export function configureSensors(reader:ConfigurationReader,trackingEnabled:(excludePaused:boolean)=>boolean){
 const sources=readSensorConfiguration(reader),store=new SensorStore(),fields=new HistoryFields(trackingEnabled);
 try{for(const {sensor} of sources)store.register(sensor,fields);return {store,fields,sources};}catch(error){store.close();throw error;}
}
