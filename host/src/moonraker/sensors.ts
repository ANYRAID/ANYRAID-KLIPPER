// Moonraker sensor.py state/store semantics. GPL-3.0-or-later.
// Original Copyright (C) 2022 Morton Jonuschat.
import {HistoryFields,type HistoryField,type HistoryFieldOptions} from './history-fields.ts';
import {HistoryTracker,type HistoryNumberType} from './history-tracker.ts';
import {ApiError,validateJson,type Json} from './rpc.ts';
import {boundedJsonBytes} from './json-size.ts';
import type {EndpointRegistry} from './endpoints.ts';
type Value=number|boolean;
export interface SensorReading {value:Value;numberType?:HistoryNumberType;}
type Reading={value:Value;numberType:HistoryNumberType};
export interface SensorHistoryField extends Omit<HistoryFieldOptions,'provider'|'reset'> {parameter:string;initTracker?:boolean;}
export interface SensorOptions {id:string;type:string;name?:string;historyProvider?:string;capacity?:number;maxParameters?:number;parameters?:Record<string,string>[];history?:SensorHistoryField[];}
function text(value:string,empty=false):string{if(typeof value!=='string'||!value.isWellFormed()||!empty&&!value||Buffer.byteLength(value)>256)throw new ApiError(400,'Invalid sensor text');return value;}
function limit(value:number,min:number,max:number):number{if(!Number.isSafeInteger(value)||value<min||value>max)throw new ApiError(400,'Invalid sensor capacity');return value;}
class Ring {
 readonly #values:Value[];#head=0;#length=0;
 constructor(capacity:number){this.#values=new Array(capacity);}
 append(value:Value):void{const capacity=this.#values.length;if(!capacity)return;this.#values[(this.#head+this.#length)%capacity]=value;if(this.#length<capacity)this.#length++;else this.#head=(this.#head+1)%capacity;}
 snapshot():Value[]{return Array.from({length:this.#length},(_,i)=>this.#values[(this.#head+i)%this.#values.length]);}
}
class Sensor {
 readonly id:string;readonly #type:string;readonly #name:string;readonly #capacity:number;readonly #maxParameters:number;readonly #parameters:Record<string,string>[];
 readonly #bindings:{parameter:string;field:HistoryField;reset?():Json}[];readonly #history=new Map<string,Ring>();
 #measurements=new Map<string,Reading>();#previous=new Map<string,Reading>();error:string|null=null;
 constructor(options:SensorOptions,capacity:number,maxParameters:number,fields?:HistoryFields){
  this.id=text(options.id);this.#type=text(options.type);this.#name=text(options.name??options.id);this.#capacity=capacity;this.#maxParameters=maxParameters;
  const parameters=options.parameters??[];validateJson(parameters);boundedJsonBytes(parameters,65536);if(!Array.isArray(parameters)||parameters.length>maxParameters||parameters.some(info=>!info||Array.isArray(info)||typeof info!=='object'||Object.keys(info).length>32||Object.values(info).some(value=>typeof value!=='string'||Buffer.byteLength(value)>4096)))throw new ApiError(400,'Invalid sensor parameter information');this.#parameters=structuredClone(parameters);
  const definitions=options.history??[];if(!Array.isArray(definitions)||definitions.length>64||definitions.length&&!fields)throw new ApiError(400,'Sensor history requires a field registry');
  const callbacks=definitions.map(definition=>{const parameter=text(definition.parameter);if(definition.initTracker!==undefined&&typeof definition.initTracker!=='boolean')throw new ApiError(400,'Invalid sensor initialization flag');return definition.initTracker?()=>this.#measurements.get(parameter)?.value??0:undefined;});
  const registered=fields?.registerBatch(definitions.map((definition,i)=>({...definition,provider:options.historyProvider??'sensor '+this.id,reset:callbacks[i]})))??[];
  const bindings=registered.map((field,i)=>({parameter:definitions[i].parameter,field,reset:callbacks[i]}));this.#bindings=[...new Set(bindings.map(binding=>binding.parameter))].flatMap(parameter=>bindings.filter(binding=>binding.parameter===parameter));
  for(const binding of this.#bindings)if(binding.reset)binding.field.tracker.setResetCallback(binding.reset,'integer');
 }
 update(input:Readonly<Record<string,SensorReading>>):void{
  try{
   if(!input||typeof input!=='object'||Array.isArray(input))throw new ApiError(400,'Invalid sensor measurements');
   const entries=Object.entries(input);if(entries.length>this.#maxParameters)throw new ApiError(400,'Invalid sensor measurements');
   const next=new Map<string,Reading>();
   for(const [name,reading] of entries){
    text(name);if(!reading||typeof reading!=='object')throw new ApiError(400,'Invalid sensor reading');const {value}=reading,numberType=reading.numberType??'float';
    if(!['float','integer'].includes(numberType)||typeof value!=='boolean'&&(typeof value!=='number'||!Number.isFinite(value))||typeof value==='number'&&numberType==='integer'&&!Number.isSafeInteger(value))throw new ApiError(422,'Invalid or unsafe sensor number');
    next.set(name,{value:typeof value==='number'&&numberType==='integer'&&value===0?0:value,numberType});
   }
   let parameterCount=this.#history.size;for(const name of next.keys())if(!this.#history.has(name)&&++parameterCount>this.#maxParameters)throw new ApiError(413,'Sensor parameter capacity exceeded');
   if(this.#bindings.length===1){const binding=this.#bindings[0],reading=next.get(binding.parameter);if(reading)binding.field.tracker.update(reading.value,reading.numberType);}
   else if(this.#bindings.length){const updates=[];for(const binding of this.#bindings){const reading=next.get(binding.parameter);if(reading)updates.push({tracker:binding.field.tracker,value:reading.value,numberType:reading.numberType});}if(updates.length)HistoryTracker.updateBatch(updates);}
   this.#measurements=next;for(const binding of this.#bindings)if(binding.reset)binding.field.tracker.setResetCallback(binding.reset,next.get(binding.parameter)?.numberType??'integer');this.error=null;
  }catch(error){this.error=error instanceof Error?error.message:'Sensor update failed';throw error;}
 }
 disconnect():void{this.error='MQTT Disconnected';this.#measurements=new Map();for(const binding of this.#bindings)if(binding.reset)binding.field.tracker.setResetCallback(binding.reset,'integer');}
 values():Record<string,Value>{return Object.fromEntries([...this.#measurements].map(([key,reading])=>[key,reading.value]));}
 sample():Record<string,Value>|undefined{
  for(const [key,reading] of this.#measurements){let ring=this.#history.get(key);if(!ring){ring=new Ring(this.#capacity);this.#history.set(key,ring);}ring.append(reading.value);}
  const changed=this.#previous.size!==this.#measurements.size||[...this.#measurements].some(([key,reading])=>!this.#previous.has(key)||Number(this.#previous.get(key)!.value)!==Number(reading.value));
  this.#previous=this.#measurements;return changed?this.values():undefined;
 }
 info(extended:boolean){return {id:this.id,friendly_name:this.#name,type:this.#type,values:this.values(),...(extended?{parameter_info:structuredClone(this.#parameters),history_fields:this.#bindings.map(binding=>({...binding.field.configuration,parameter:binding.parameter}))}:{})};}
 measurements():Record<string,Value[]>{return Object.fromEntries([...this.#history].map(([key,ring])=>[key,ring.snapshot()]));}
}
/** Generic sensor telemetry only. Source adapters supply already decoded typed
 * measurements; sampling and history accumulation never control motion/heaters. */
export class SensorStore {
 readonly #sensors=new Map<string,Sensor>();readonly #maxSensors:number;readonly #maxSlots:number;#reserved=0;#closed=false;
 constructor({maxSensors=32,maxSlots=1000000}:{maxSensors?:number;maxSlots?:number}={}){this.#maxSensors=limit(maxSensors,1,1024);this.#maxSlots=limit(maxSlots,0,16000000);}
 #open(){if(this.#closed)throw new ApiError(503,'Sensor store is closed');}
 #sensor(id:string):Sensor{const sensor=this.#sensors.get(text(id,true));if(!sensor)throw new ApiError(500,`No valid sensor named ${id}`);return sensor;}
 register(options:SensorOptions,fields?:HistoryFields):void{
  this.#open();const id=text(options.id),capacity=limit(options.capacity??1200,0,100000),parameters=limit(options.maxParameters??16,1,256),slots=capacity*parameters;
  if(this.#sensors.has(id))throw new ApiError(409,'Sensor already registered');if(this.#sensors.size>=this.#maxSensors||this.#reserved+slots>this.#maxSlots)throw new ApiError(413,'Sensor store capacity exceeded');
  const sensor=new Sensor(options,capacity,parameters,fields);this.#sensors.set(id,sensor);this.#reserved+=slots;
 }
 get closed():boolean{return this.#closed;}
 get status(){return {closed:this.#closed,sensors:this.#sensors.size,reservedSlots:this.#reserved,errors:Object.fromEntries([...this.#sensors].filter(([,sensor])=>sensor.error!==null).map(([id,sensor])=>[id,sensor.error]))};}
 update(id:string,input:Readonly<Record<string,SensorReading>>):void{this.#open();this.#sensor(id).update(input);}
 recordError(id:string,message:string):void{this.#open();if(typeof message!=='string')throw new ApiError(400,'Invalid sensor error');this.#sensor(id).error=message.slice(0,4096);}
 disconnect(id:string):void{this.#open();this.#sensor(id).disconnect();}
 sample():Record<string,Record<string,Value>>{this.#open();const changed:[string,Record<string,Value>][]=[];for(const [id,sensor] of this.#sensors){const value=sensor.sample();if(value!==undefined)changed.push([id,value]);}return Object.fromEntries(changed);}
 list(extended=false){return {sensors:Object.fromEntries([...this.#sensors].map(([id,sensor])=>[id,sensor.info(extended)]))};}
 info(id:string,extended=false){return this.#sensor(id).info(extended);}
 measurements(id=''):Record<string,Record<string,Value[]>>{return Object.fromEntries(id?[[id,this.#sensor(id).measurements()]]:[...this.#sensors].map(([name,sensor])=>[name,sensor.measurements()]));}
 close():void{this.#closed=true;}
}
function extended(value:Json|undefined):boolean{if(value===undefined)return false;if(typeof value==='boolean')return value;if(typeof value==='string'&&['true','false'].includes(value.toLowerCase()))return value.toLowerCase()==='true';throw new ApiError(400,'Invalid extended argument');}
export function registerSensors(registry:EndpointRegistry,store:SensorStore):()=>void{
 if(!(store instanceof SensorStore))throw new ApiError(400,'Invalid sensor store');const releases:(()=>void)[]=[];
 try{
  releases.push(registry.register({endpoint:'/server/sensors/list',methods:['GET']},params=>store.list(extended(params.extended)) as unknown as Json));
  releases.push(registry.register({endpoint:'/server/sensors/info',methods:['GET']},params=>{if(typeof params.sensor!=='string')throw new ApiError(400,'Missing sensor argument');return store.info(params.sensor,extended(params.extended)) as unknown as Json;}));
  releases.push(registry.register({endpoint:'/server/sensors/measurements',methods:['GET']},params=>{if(params.sensor!==undefined&&typeof params.sensor!=='string')throw new ApiError(400,'Invalid sensor argument');return store.measurements(params.sensor as string|undefined) as unknown as Json;}));
 }catch(error){for(const release of releases)release();throw error;}return ()=>{for(const release of releases)release();};
}
