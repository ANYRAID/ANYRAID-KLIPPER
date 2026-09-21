// Moonraker sensor.py _on_state_update / _set_result ingress semantics.
// GPL-3.0-or-later. Original Copyright (C) 2022 Morton Jonuschat.
import {isUtf8} from 'node:buffer';
import {SensorStore,type SensorReading} from './sensors.ts';
import type {HistoryNumberType} from './history-tracker.ts';
import {parseConfigurationFloat} from './config-reader.ts';
import {ApiError} from './rpc.ts';
export interface SensorTemplateContext {
 readonly payload:string;
 setResult(name:string,value:number|boolean|string,numberType?:HistoryNumberType):void;
}
export type SensorRenderer=(context:SensorTemplateContext)=>unknown;
/** Synchronous ingress boundary for a compiled template and MQTT bytes. This
 * class neither compiles Jinja nor owns a broker connection. No partial frame
 * is visible if decoding, rendering, validation or history accumulation fails. */
export class SensorMessages {
 readonly #store:SensorStore;readonly #id:string;readonly #render:SensorRenderer;
 readonly #maxBytes:number;readonly #maxParameters:number;
 #closed=false;#busy=false;#generation=0;#received=0;#accepted=0;#rejected=0;#ignored=0;
 constructor(store:SensorStore,id:string,render:SensorRenderer,{maxBytes=65536,maxParameters=16}:{maxBytes?:number;maxParameters?:number}={}){
  if(!(store instanceof SensorStore)||store.closed||typeof render!=='function'||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>1048576||!Number.isSafeInteger(maxParameters)||maxParameters<1||maxParameters>256)throw new ApiError(400,'Invalid sensor message source');
  store.info(id);this.#store=store;this.#id=id;this.#render=render;this.#maxBytes=maxBytes;this.#maxParameters=maxParameters;
 }
 owns(store:SensorStore):boolean{return this.#store===store;}
 get status(){return {closed:this.#closed,received:this.#received,accepted:this.#accepted,rejected:this.#rejected,ignored:this.#ignored};}
 receive(payload:Uint8Array):boolean{
  if(this.#closed||this.#store.closed){this.#ignored++;return false;}
  this.#received++;if(this.#busy){this.#generation++;this.#rejected++;this.#store.recordError(this.#id,'Reentrant sensor message');return false;}
  this.#busy=true;const generation=this.#generation;let active=true;
  try{
   if(!(payload instanceof Uint8Array)||payload.byteLength>this.#maxBytes)throw new ApiError(413,'Sensor payload exceeds byte limit');
   if(!isUtf8(payload))throw new ApiError(422,'Invalid sensor UTF-8 payload');
   const decoded=(Buffer.isBuffer(payload)?payload:Buffer.from(payload.buffer,payload.byteOffset,payload.byteLength)).toString('utf8');
   const values:Record<string,SensorReading>=Object.create(null);let count=0;
   const context:SensorTemplateContext=Object.freeze({payload:decoded,setResult:(name:string,value:number|boolean|string,numberType?:HistoryNumberType)=>{
    if(!active||generation!==this.#generation||this.#closed||this.#store.closed)throw new ApiError(409,'Sensor frame is no longer active');
    if(typeof name!=='string'||!name||name.length>256)throw new ApiError(422,'Invalid sensor parameter');
    if(!Object.hasOwn(values,name)&&++count>this.#maxParameters)throw new ApiError(413,'Sensor parameter capacity exceeded');
    if(typeof value==='string'){value=parseConfigurationFloat(value);numberType='float';}
    values[name]={value,numberType:numberType??'float'};
   }});
   const result=this.#render(context);
   if(result&&typeof (result as {then?:unknown}).then==='function'){void Promise.resolve(result).catch(()=>{});throw new ApiError(502,'Sensor template must be synchronous');}
   if(generation!==this.#generation||this.#closed||this.#store.closed)throw new ApiError(409,'Sensor source closed during rendering');
   this.#store.update(this.#id,values);this.#accepted++;return true;
  }catch(error){this.#rejected++;if(!this.#closed&&!this.#store.closed)this.#store.recordError(this.#id,error instanceof Error?error.message:'Sensor render failed');return false;}
  finally{active=false;this.#busy=false;}
 }
 disconnect():void{this.#generation++;if(!this.#closed&&!this.#store.closed)this.#store.disconnect(this.#id);}
 close():void{this.#generation++;this.#closed=true;}
}
