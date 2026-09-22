// Connection configuration from Moonraker mqtt.py. GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan.
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {homedir} from 'node:os';
import {isAbsolute} from 'node:path';
import {ConfigurationError} from './config-source.ts';
import type {ConfigurationReader} from './config-reader.ts';
import type {MqttSensorOptions} from './mqtt-sensors.ts';
const strip=(value:string)=>value.replace(/^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g,'');
export interface MqttConfigurationContext {
 cwd?:string;home?:string;
 /** Template/secrets ownership remains explicit until the full component is ported. */
 render?:(source:string)=>string|Promise<string>;
}
async function credential(source:string|null,context:MqttConfigurationContext):Promise<string|undefined>{
 if(source===null)return undefined;
 if(!context.render&&/[{}]/u.test(source))throw new ConfigurationError('MQTT credential template renderer is required');
 const value=context.render?await context.render(source):source;
 if(typeof value!=='string'||!value.isWellFormed())throw new ConfigurationError('Invalid MQTT credential');
 const result=strip(value);if(Buffer.byteLength(result)>65535)throw new ConfigurationError('MQTT credential exceeds byte limit');return result;
}
async function passwordFile(source:string,context:MqttConfigurationContext):Promise<string>{
 let path=source;
 if(path==='~'||path.startsWith('~/')){const home=context.home??homedir();if(!isAbsolute(home))throw new ConfigurationError('MQTT home directory must be absolute');path=home+path.slice(1);}
 else if(path.startsWith('~'))throw new ConfigurationError('Named-user MQTT password paths are not implemented');
 if(!isAbsolute(path)){const cwd=context.cwd??process.cwd();if(!isAbsolute(cwd))throw new ConfigurationError('MQTT working directory must be absolute');path=cwd+'/'+path;}
 const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>65535)throw new ConfigurationError('Invalid MQTT password file');
  const bytes=Buffer.alloc(65536);let length=0;
  while(length<bytes.length){const {bytesRead}=await file.read(bytes,length,bytes.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  if(length>65535)throw new ConfigurationError('MQTT password file exceeds byte limit');
  // pathlib.read_text uses universal newline conversion before strip().
  return strip(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,length)).replace(/\r\n?/g,'\n'));
 }finally{await file.close();}
}
/** Reads connection options only. Unsupported MQTT versions fail explicitly;
 * status publication, API transport and instance topics remain separate work. */
export async function readMqttSensorOptions(reader:ConfigurationReader,context:MqttConfigurationContext={}):Promise<MqttSensorOptions>{
 const section=reader.section('mqtt');
 try{
  const host=section.get('address'),port=section.getInt('port',{defaultValue:1883,minval:1,maxval:65535}),tls=section.getBoolean('enable_tls',{defaultValue:false});
  const username=await credential(section.get('username',{defaultValue:null}),context);
  const path=section.get('password_file',{defaultValue:null,deprecate:true}),template=section.get('password',{defaultValue:null});
  // Upstream reads the file even when a later template overrides its value.
  let password=path===null?undefined:await passwordFile(path,context);
  if(template!==null)password=await credential(template,context);
  if(section.get('mqtt_protocol',{defaultValue:'v3.1.1'})!=='v3.1.1')throw new ConfigurationError('MQTT protocol is not supported by this transport');
  const defaultQos=section.getInt('default_qos',{defaultValue:0,minval:0,maxval:2}) as 0|1|2,clientId=section.get('client_id',{defaultValue:''});
  if(!host||host.length>253||/[\s/\0]/u.test(host)||!clientId.isWellFormed()||Buffer.byteLength(clientId)>65535)throw new ConfigurationError('Invalid MQTT connection options');
  return {host,port,tls,defaultQos,...username!==undefined?{username}:{},...password!==undefined?{password}:{},...clientId?{clientId}:{}};
 }catch{reader.error('mqtt');throw new ConfigurationError('[mqtt]: Unable to load connection configuration');}
}
