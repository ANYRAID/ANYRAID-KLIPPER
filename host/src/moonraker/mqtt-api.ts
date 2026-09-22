// Moonraker mqtt.py publish endpoint. GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import {parseConfigurationInteger,parseConfigurationFloat} from './config-reader.ts';
import type {MqttPublishOptions} from './mqtt-sensors.ts';
export interface MqttPublisher {publish(topic:string,payload:string,options:MqttPublishOptions):Promise<void>;}
/** JSON payloads preserve their numeric value; callers requiring exact lexical
 * decimal formatting must provide a string, as the RPC layer uses Number. */
export function mqttPublishPayload(value:Json|undefined):string{
 if(value===undefined||value===null)return '';
 validateJson(value);
 if(typeof value==='string')return value;
 if(typeof value==='number'&&Object.is(value,-0))return '-0.0';
 return JSON.stringify(value);
}
function qos(value:Json|undefined):0|1|2|undefined{
 if(value===undefined)return undefined;
 let result:number;
 try{result=typeof value==='string'?parseConfigurationInteger(value):typeof value==='boolean'?Number(value):typeof value==='number'?Math.trunc(value):NaN;}catch{result=NaN;}
 if(!Number.isInteger(result)||result<0||result>2)throw new ApiError(400,'Invalid MQTT qos');return result as 0|1|2;
}
function retain(value:Json|undefined):boolean{
 if(value===undefined)return false;if(typeof value==='boolean')return value;
 if(typeof value==='string'&&['true','false'].includes(value.toLowerCase()))return value.toLowerCase()==='true';throw new ApiError(400,'Invalid MQTT retain');
}
function deadline(value:Json|undefined):number|undefined{
 if(value===undefined)return undefined;
 let seconds:number;
 try{seconds=typeof value==='string'?parseConfigurationFloat(value):typeof value==='boolean'?Number(value):typeof value==='number'?value:NaN;}catch{seconds=NaN;}
 if(!Number.isFinite(seconds)||seconds>120)throw new ApiError(400,'Invalid MQTT timeout');
 if(seconds<=0)throw new ApiError(504,'MQTT Publish Timed Out');return Math.max(1,Math.ceil(seconds*1000));
}
export function registerMqttPublish(registry:EndpointRegistry,publisher:MqttPublisher):()=>void{
 return registry.register({endpoint:'/server/mqtt/publish',methods:['POST'],transports:['http','websocket','unix']},async(params,_verb,context)=>{
  if(typeof params.topic!=='string')throw new ApiError(400,'Missing or invalid MQTT topic');
  const options={qos:qos(params.qos),retain:retain(params.retain),timeoutMs:deadline(params.timeout),signal:context.signal};
  await publisher.publish(params.topic,mqttPublishPayload(params.payload),options);return {topic:params.topic};
 });
}
