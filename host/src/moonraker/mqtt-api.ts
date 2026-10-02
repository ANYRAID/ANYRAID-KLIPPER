// Moonraker mqtt.py publish endpoint. GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan.
import {ApiError,validateJson,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import {parseConfigurationInteger,parseConfigurationFloat} from './config-reader.ts';
import type {MqttPublishOptions} from './mqtt-sensors.ts';
import type {MqttWaitOptions} from './mqtt-waiters.ts';
import {isUtf8} from 'node:buffer';
import {parseRequestJson,JsonNumberError} from './json.ts';
export interface MqttPublisher {publish(topic:string,payload:string,options:MqttPublishOptions):Promise<void>;}
export interface MqttSubscriber {waitForMessage(topic:string,options:MqttWaitOptions):Promise<Buffer>;}
export function mqttSubscriptionPayload(bytes:Uint8Array):Json{
 if(!(bytes instanceof Uint8Array)||bytes.byteLength>65536)throw new ApiError(413,'MQTT subscription payload exceeds byte limit');
 if(!isUtf8(bytes))throw new ApiError(422,'Invalid MQTT subscription UTF-8');
 const text=(Buffer.isBuffer(bytes)?bytes:Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength)).toString('utf8');let value:unknown;
 const json=text.startsWith('\ufeff')?text.slice(1):text;
 // Every valid JSON value starts with one of these tokens after JSON whitespace.
 // Ordinary text should not allocate a parser exception on every message.
 if(!/^[\x20\t\r\n]*(?:[\[{"0-9-]|true|false|null)/u.test(json))return text;
 try{value=parseRequestJson(json);}
 catch(error){if(error instanceof JsonNumberError)throw new ApiError(422,'MQTT JSON number exceeds safe range');if(error instanceof SyntaxError)return text;throw error;}
 try{validateJson({payload:value});}catch{throw new ApiError(422,'Invalid MQTT JSON structure');}return value as Json;
}
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
function deadline(value:Json|undefined,operation='Publish'):number|undefined{
 if(value===undefined)return undefined;
 let seconds:number;
 try{seconds=typeof value==='string'?parseConfigurationFloat(value):typeof value==='boolean'?Number(value):typeof value==='number'?value:NaN;}catch{seconds=NaN;}
 if(!Number.isFinite(seconds)||seconds>120)throw new ApiError(400,'Invalid MQTT timeout');
 if(seconds<=0)throw new ApiError(504,`MQTT ${operation} Timed Out`);return Math.max(1,Math.ceil(seconds*1000));
}
export function registerMqttSubscribe(registry:EndpointRegistry,subscriber:MqttSubscriber):()=>void{
 return registry.register({endpoint:'/server/mqtt/subscribe',methods:['POST'],transports:['http','websocket','unix']},async(params,_verb,context)=>{
  if(typeof params.topic!=='string')throw new ApiError(400,'Missing or invalid MQTT topic');
  const bytes=await subscriber.waitForMessage(params.topic,{qos:qos(params.qos),timeoutMs:deadline(params.timeout,'Subscribe'),signal:context.signal});
  return {topic:params.topic,payload:mqttSubscriptionPayload(bytes)};
 });
}
export function registerMqttPublish(registry:EndpointRegistry,publisher:MqttPublisher):()=>void{
 return registry.register({endpoint:'/server/mqtt/publish',methods:['POST'],transports:['http','websocket','unix']},async(params,_verb,context)=>{
  if(typeof params.topic!=='string')throw new ApiError(400,'Missing or invalid MQTT topic');
  const options={qos:qos(params.qos),retain:retain(params.retain),timeoutMs:deadline(params.timeout),signal:context.signal};
  await publisher.publish(params.topic,mqttPublishPayload(params.payload),options);return {topic:params.topic};
 });
}
