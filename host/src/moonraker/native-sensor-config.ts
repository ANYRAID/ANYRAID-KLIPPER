/** Native sensor assembly used by the configured server and explicit callers.
 * Constructing a generation does not start a broker connection. */
import {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
import {configureSensors} from './sensor-config.ts';
import {SensorMessages} from './sensor-messages.ts';
import {SensorStore} from './sensors.ts';
import {NativeTemplateCandidate} from './native-template.ts';
import {MqttSensors,type MqttSensorOptions} from './mqtt-sensors.ts';
import {readMqttSensorOptions,type MqttConfigurationContext} from './mqtt-config.ts';
import {MoonrakerRenderableTemplate} from './template-factory.ts';
import type {HistoryFields} from './history-fields.ts';

/** Explicit candidate entry using both [mqtt] and [sensor ...] configuration. */
export async function configureNativeSensorsFromConfig(reader:ConfigurationReader,trackingEnabled:(excludePaused:boolean)=>boolean,context:MqttConfigurationContext={},registry?:HistoryFields){
 return configureNativeSensors(reader,trackingEnabled,await readMqttSensorOptions(reader,context),registry);
}

export class NativeSensorMessages extends SensorMessages {
 readonly #template:NativeTemplateCandidate;
 constructor(store:SensorStore,id:string,source:string){
  const template=new NativeTemplateCandidate(source);
  try{super(store,id,template.renderer);}catch(error){template.close();throw error;}
  this.#template=template;
 }
 override close():void{super.close();this.#template.close();}
}

/** Owns one synchronous handle borrowed from the process's shared environment.
 * Rust batches set_result values; SensorMessages publishes a complete frame. */
export class SharedSensorMessages extends SensorMessages {
 readonly #template:MoonrakerRenderableTemplate;
 constructor(store:SensorStore,id:string,template:MoonrakerRenderableTemplate){
  if(!(template instanceof MoonrakerRenderableTemplate)||template.isAsync)throw new ConfigurationError('Sensor template requires a synchronous shared owner');
  try{super(store,id,context=>{for(const value of template.renderSensor(context.payload))context.setResult(value.name,value.numberType==='boolean'?value.booleanValue!:value.numberValue!,value.numberType==='boolean'?undefined:value.numberType);});}catch(error){template.close();throw error;}
  this.#template=template;
 }
 override close():void{super.close();this.#template.close();}
}

/** Caller owns the returned generation until transferring its store and
 * transport to ConfiguredMoonraker. Failed assembly releases every template. */
export function configureNativeSensors(reader:ConfigurationReader,trackingEnabled:(excludePaused:boolean)=>boolean,options:MqttSensorOptions,registry?:HistoryFields){
 const rollback=registry?.registrationRollback();
 const generation=configureSensors(reader,trackingEnabled,registry),receivers:(NativeSensorMessages|SharedSensorMessages)[]=[];
 try{
  const bindings=generation.sources.map(({sensor,mqtt})=>{
   let receiver:NativeSensorMessages|SharedSensorMessages;
   try{receiver=reader.hasTemplates()?new SharedSensorMessages(generation.store,sensor.id,reader.templates().createTemplate(mqtt.template)):new NativeSensorMessages(generation.store,sensor.id,mqtt.template);}
   catch(error){reader.error(sensor.historyProvider!);throw new ConfigurationError(`[${sensor.historyProvider}]: Invalid sensor template`,{cause:error});}
   receivers.push(receiver);return {topic:mqtt.topic,qos:mqtt.qos as 0|1|2|null,receiver};
  });
  const sensorTransport=new MqttSensors(options,bindings);
  return {sensors:generation.store,fields:generation.fields,sources:generation.sources,receivers,sensorTransport,
   async close(){try{await sensorTransport.close();}finally{generation.store.close();}}};
 }catch(error){rollback?.();for(const receiver of receivers)receiver.close();generation.store.close();throw error;}
}
