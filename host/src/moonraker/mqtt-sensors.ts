import {MqttClient,type IClientOptions} from 'mqtt';
import {connect as tcpConnect,isIP} from 'node:net';
import {connect as tlsConnect} from 'node:tls';
import {Duplex,Transform,type TransformCallback} from 'node:stream';
import type {SensorStore} from './sensors.ts';
import {SensorMessages} from './sensor-messages.ts';
import {ApiError} from './rpc.ts';
type QoS=0|1|2;
const receiverOwners=new WeakSet<SensorMessages>();
export interface MqttSensorBinding {topic:string;qos?:QoS|null;receiver:SensorMessages;}
export interface MqttSensorOptions {host:string;port?:number;tls?:boolean;ca?:string;username?:string;password?:string;clientId?:string;defaultQos?:QoS;reconnectMs?:number;timeoutMs?:number;maxPacketBytes?:number;}
/** MQTT Remaining Length guard before MQTT.js buffering/parsing. */
export class MqttPacketLimit extends Transform {
 readonly #max:number;#phase=0;#length=0;#multiplier=1;#digits=0;#remaining=0;
 constructor(max:number){super();if(!Number.isSafeInteger(max)||max<2||max>16777216)throw new ApiError(400,'Invalid MQTT packet limit');this.#max=max;}
 override _transform(chunk:Buffer,_encoding:BufferEncoding,done:TransformCallback):void{
  try{
   for(let i=0;i<chunk.length;){
    if(this.#phase===2){const consumed=Math.min(this.#remaining,chunk.length-i);this.#remaining-=consumed;i+=consumed;if(!this.#remaining)this.#phase=0;continue;}
    const byte=chunk[i++];if(this.#phase===0){this.#phase=1;this.#length=0;this.#multiplier=1;this.#digits=0;continue;}
    this.#digits++;this.#length+=(byte&127)*this.#multiplier;
    if(this.#length+1+this.#digits>this.#max)throw new Error('MQTT packet exceeds byte limit');
    if(byte&128){if(this.#digits===4)throw new Error('Invalid MQTT remaining length');this.#multiplier*=128;}
    else{this.#remaining=this.#length;this.#phase=this.#remaining?2:0;}
   }
   done(null,chunk);
  }catch(error){done(error as Error);}
 }
 override _flush(done:TransformCallback):void{done(this.#phase?new Error('Truncated MQTT packet'):undefined);}
}
function bounded(value:number,min:number,max:number){if(!Number.isSafeInteger(value)||value<min||value>max)throw new ApiError(400,'Invalid MQTT numeric option');return value;}
/** Dedicated sensor MQTT 3.1.1 connection. No status publication or RPC transport.
 * All bindings are fixed before connect; reconnect builds a fresh subscription
 * generation, and close fences receivers before destroying the transport. */
export class MqttSensors {
 readonly #client:MqttClient;readonly #topics=new Map<string,{qos:QoS;receivers:SensorMessages[]}>();readonly #timeout:number;
 #closed=false;#started=false;#connected=false;#ready=false;#generation=0;#connections=0;#messages=0;#failure:string|null=null;
 #starting:Promise<void>|undefined;#resolve:(()=>void)|undefined;#reject:((error:Error)=>void)|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#closing:Promise<void>|undefined;
 constructor(options:MqttSensorOptions,bindings:readonly MqttSensorBinding[]){
  if(!options||typeof options.host!=='string'||!options.host||options.host.length>253||/[\s/\0]/u.test(options.host)||!Array.isArray(bindings)||bindings.length>32)throw new ApiError(400,'Invalid MQTT sensor options');
  if(options.ca!==undefined&&!options.tls||options.tls!==undefined&&typeof options.tls!=='boolean'||[options.ca,options.username,options.password,options.clientId].some(value=>value!==undefined&&(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>65535)))throw new ApiError(400,'Invalid MQTT connection option');
  const port=bounded(options.port??(options.tls?8883:1883),1,65535),qos=bounded(options.defaultQos??0,0,2) as QoS,reconnect=bounded(options.reconnectMs??1000,10,60000),max=bounded(options.maxPacketBytes??131072,2,16777216);this.#timeout=bounded(options.timeoutMs??10000,10,120000);
  const receivers=new Set<SensorMessages>();
  for(const binding of bindings){if(!binding||!(binding.receiver instanceof SensorMessages)||binding.receiver.status.closed||typeof binding.topic!=='string'||!binding.topic||!binding.topic.isWellFormed()||Buffer.byteLength(binding.topic)>65535||/[+#\0]/u.test(binding.topic))throw new ApiError(400,'Invalid MQTT sensor binding');
   if(receiverOwners.has(binding.receiver)||receivers.has(binding.receiver))throw new ApiError(409,'Sensor receiver already owned');receivers.add(binding.receiver);
   // Upstream subscribe_topic uses `qos or self.qos`, including explicit zero.
   const requested=bounded(binding.qos??qos,0,2)||qos,previous=this.#topics.get(binding.topic);if(previous){previous.qos=Math.max(previous.qos,requested) as QoS;previous.receivers.push(binding.receiver);}else this.#topics.set(binding.topic,{qos:requested as QoS,receivers:[binding.receiver]});
  }
  const host=options.host,tls=options.tls??false,ca=options.ca;
  const clientOptions:IClientOptions={manualConnect:true,protocolVersion:4,clean:true,resubscribe:false,queueQoSZero:false,reconnectPeriod:reconnect,connectTimeout:this.#timeout,keepalive:30,username:options.username,password:options.password,clientId:options.clientId};
  this.#client=new MqttClient(()=>{
   const socket=tls?tlsConnect({host,port,ca,rejectUnauthorized:true,...!isIP(host)?{servername:host}:{}}):tcpConnect({host,port});
   const guard=new MqttPacketLimit(max),stream=new Duplex({read(){guard.resume();},write(chunk,encoding,done){socket.write(chunk,encoding,done);},final(done){socket.end(done);},destroy(error,done){socket.destroy();guard.destroy();done(error);}});
   guard.on('data',chunk=>{if(!stream.push(chunk))guard.pause();});guard.on('end',()=>stream.push(null));guard.on('error',error=>stream.destroy(error));socket.on('error',error=>stream.destroy(error));socket.on('close',()=>stream.destroy());socket.pipe(guard);return stream;
  },clientOptions);
  this.#client.on('error',()=>{this.#failure='MQTT transport error';});
  this.#client.on('close',()=>{this.#generation++;this.#connected=false;this.#ready=false;for(const group of this.#topics.values())for(const receiver of group.receivers)receiver.disconnect();});
  this.#client.on('connect',()=>{if(this.#closed)return;const generation=++this.#generation;this.#connected=true;this.#connections++;this.#ready=false;const subscriptions=Object.fromEntries([...this.#topics].map(([topic,group])=>[topic,{qos:group.qos}]));
   if(!this.#topics.size){this.#subscribed(generation);return;}
   this.#client.subscribe(subscriptions,(error,grants)=>{if(this.#closed||generation!==this.#generation)return;if(error||!grants||grants.length!==this.#topics.size||grants.some(grant=>grant.qos>2)){this.#failure='MQTT subscription rejected';return;}this.#subscribed(generation);});
  });
  this.#client.on('message',(topic,payload)=>{if(this.#closed||!this.#connected)return;const group=this.#topics.get(topic);if(!group)return;this.#messages++;for(const receiver of group.receivers)receiver.receive(payload);});
  for(const receiver of receivers)receiverOwners.add(receiver);
 }
 #subscribed(generation:number){if(this.#closed||generation!==this.#generation)return;this.#ready=true;this.#failure=null;clearTimeout(this.#timer);this.#resolve?.();this.#resolve=undefined;this.#reject=undefined;}
 owns(store:SensorStore):boolean{return [...this.#topics.values()].every(group=>group.receivers.every(receiver=>receiver.owns(store)));}
 get status(){return {started:this.#started,closed:this.#closed,connected:this.#connected,ready:this.#ready,connections:this.#connections,messages:this.#messages,failure:this.#failure};}
 start():Promise<void>{if(this.#closed)return Promise.reject(new Error('MQTT sensors are closed'));if(this.#starting)return this.#starting;
  this.#starting=new Promise<void>((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;this.#timer=setTimeout(()=>{this.#failure='MQTT startup timed out';reject(new Error(this.#failure));void this.close();},this.#timeout);this.#started=true;this.#client.connect();});return this.#starting;
 }
 close():Promise<void>{if(this.#closing)return this.#closing;this.#closed=true;this.#generation++;this.#connected=false;this.#ready=false;clearTimeout(this.#timer);this.#reject?.(new Error('MQTT sensors closed during startup'));this.#resolve=undefined;this.#reject=undefined;for(const group of this.#topics.values())for(const receiver of group.receivers){receiver.disconnect();receiver.close();}this.#closing=this.#started?this.#client.endAsync(true):Promise.resolve();return this.#closing;}
}
