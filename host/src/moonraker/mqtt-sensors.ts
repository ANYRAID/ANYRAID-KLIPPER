import {MqttClient,type IClientOptions} from 'mqtt';
import {connect as tcpConnect,isIP} from 'node:net';
import {hostname} from 'node:os';
import {connect as tlsConnect} from 'node:tls';
import {Duplex,Transform,type TransformCallback} from 'node:stream';
import type {SensorStore} from './sensors.ts';
import {SensorMessages} from './sensor-messages.ts';
import {ApiError} from './rpc.ts';
import {MqttMessageWaiters,type MqttWaitOptions} from './mqtt-waiters.ts';
type QoS=0|1|2;
const receiverOwners=new WeakSet<SensorMessages>();
export interface MqttSensorBinding {topic:string;qos?:QoS|null;receiver:SensorMessages;}
export type MqttProtocol='v3.1'|'v3.1.1'|'v5';
export interface MqttPublishOptions {qos?:QoS;retain?:boolean;timeoutMs?:number;signal?:AbortSignal;}
export interface MqttSensorOptions {instanceName?:string;protocol?:MqttProtocol;host:string;port?:number;tls?:boolean;ca?:string;username?:string;password?:string;clientId?:string;defaultQos?:QoS;reconnectMs?:number;timeoutMs?:number;maxPacketBytes?:number;}
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
/** Shared MQTT 3.1/3.1.1/5 transport for sensors and Moonraker publication.
 * Sensor bindings are fixed; one-shot waits are bounded and generation scoped.
 * Reconnect builds a fresh subscription
 * generation, and close fences receivers before destroying the transport. */
export class MqttSensors {
 readonly instanceName:string;
 readonly #waiters:MqttMessageWaiters;readonly #client:MqttClient;readonly #topics=new Map<string,{qos:QoS;receivers:SensorMessages[]}>();readonly #timeout:number;readonly #defaultQos:QoS;readonly #publishes=new Set<(error:Error)=>void>();
 #rpcReceiver:((payload:Buffer,retained:boolean,signal:AbortSignal)=>void)|undefined;#rpcTopic:string|undefined;#rpcGeneration=new AbortController();
 #presence=false;#presenceOnline=false;#presenceFailures=0;
 #closed=false;#started=false;#connected=false;#ready=false;#generation=0;#connections=0;#messages=0;#failure:string|null=null;
 #starting:Promise<void>|undefined;#resolve:(()=>void)|undefined;#reject:((error:Error)=>void)|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#closing:Promise<void>|undefined;
 constructor(options:MqttSensorOptions,bindings:readonly MqttSensorBinding[]){
  if(!options||typeof options.host!=='string'||!options.host||options.host.length>253||/[\s/\0]/u.test(options.host)||!Array.isArray(bindings)||bindings.length>32)throw new ApiError(400,'Invalid MQTT sensor options');
  if(options.ca!==undefined&&!options.tls||options.tls!==undefined&&typeof options.tls!=='boolean'||[options.ca,options.username,options.password,options.clientId].some(value=>value!==undefined&&(typeof value!=='string'||!value.isWellFormed()||Buffer.byteLength(value)>65535)))throw new ApiError(400,'Invalid MQTT connection option');
  this.instanceName=options.instanceName??hostname();if(typeof this.instanceName!=='string'||!this.instanceName.isWellFormed()||Buffer.byteLength(this.instanceName)>65535||/[+#\0]/u.test(this.instanceName))throw new ApiError(400,'Invalid MQTT instance name');
  const protocol=options.protocol??'v3.1.1';if(!['v3.1','v3.1.1','v5'].includes(protocol))throw new ApiError(400,'Invalid MQTT protocol');
  const port=bounded(options.port??(options.tls?8883:1883),1,65535),qos=bounded(options.defaultQos??0,0,2) as QoS,reconnect=bounded(options.reconnectMs??1000,10,60000),max=bounded(options.maxPacketBytes??131072,2,16777216);this.#timeout=bounded(options.timeoutMs??10000,10,120000);this.#defaultQos=qos as QoS;
  const receivers=new Set<SensorMessages>();
  for(const binding of bindings){if(!binding||!(binding.receiver instanceof SensorMessages)||binding.receiver.status.closed||typeof binding.topic!=='string'||!binding.topic||!binding.topic.isWellFormed()||Buffer.byteLength(binding.topic)>65535||/[+#\0]/u.test(binding.topic))throw new ApiError(400,'Invalid MQTT sensor binding');
   if(receiverOwners.has(binding.receiver)||receivers.has(binding.receiver))throw new ApiError(409,'Sensor receiver already owned');receivers.add(binding.receiver);
   // Upstream subscribe_topic uses `qos or self.qos`, including explicit zero.
   const requested=bounded(binding.qos??qos,0,2)||qos,previous=this.#topics.get(binding.topic);if(previous){previous.qos=Math.max(previous.qos,requested) as QoS;previous.receivers.push(binding.receiver);}else this.#topics.set(binding.topic,{qos:requested as QoS,receivers:[binding.receiver]});
  }
  const host=options.host,tls=options.tls??false,ca=options.ca;
  const clientOptions:IClientOptions={manualConnect:true,protocolVersion:protocol==='v5'?5:protocol==='v3.1'?3:4,protocolId:protocol==='v3.1'?'MQIsdp':'MQTT',clean:true,resubscribe:false,queueQoSZero:false,reconnectPeriod:reconnect,connectTimeout:this.#timeout,keepalive:30,username:options.username,password:options.password,clientId:options.clientId};
  this.#client=new MqttClient(()=>{
   const socket=tls?tlsConnect({host,port,ca,rejectUnauthorized:true,...!isIP(host)?{servername:host}:{}}):tcpConnect({host,port});
   const guard=new MqttPacketLimit(max),stream=new Duplex({read(){guard.resume();},write(chunk,encoding,done){socket.write(chunk,encoding,done);},writev(chunks,done){socket.write(Buffer.concat(chunks.map(item=>item.chunk as Buffer)),done);},final(done){socket.end(done);},destroy(error,done){socket.destroy();guard.destroy();done(error);}});
   guard.on('data',chunk=>{if(!stream.push(chunk))guard.pause();});guard.on('end',()=>stream.push(null));guard.on('error',error=>stream.destroy(error));socket.on('error',error=>stream.destroy(error));socket.on('close',()=>stream.destroy());socket.pipe(guard);return stream;
  },clientOptions);
  this.#waiters=new MqttMessageWaiters(this.#client,this.#topics,()=>!this.#closed&&this.#ready&&this.#client.connected&&!this.#client.stream.destroyed,this.#defaultQos,this.#timeout);
  this.#client.on('error',()=>{this.#failure='MQTT transport error';});
  this.#client.on('close',()=>{this.#rpcGeneration.abort();this.#waiters.disconnect();this.#failPublishes(new ApiError(503,'MQTT disconnected; delivery may be unknown'));this.#generation++;this.#connected=false;this.#ready=false;this.#presenceOnline=false;for(const group of this.#topics.values())for(const receiver of group.receivers)receiver.disconnect();});
  this.#client.on('connect',()=>{if(this.#closed)return;this.#rpcGeneration.abort();this.#rpcGeneration=new AbortController();const generation=++this.#generation;this.#connected=true;this.#connections++;this.#ready=false;const subscriptions=Object.fromEntries([...this.#topics].map(([topic,group])=>[topic,{qos:group.qos}]));
   if(!this.#topics.size){this.#subscribed(generation);return;}
   this.#client.subscribe(subscriptions,(error,grants)=>{if(this.#closed||generation!==this.#generation)return;if(error||!grants||grants.length!==this.#topics.size||grants.some(grant=>grant.qos>2)){this.#failure='MQTT subscription rejected';return;}this.#subscribed(generation);});
  });
  this.#client.on('message',(topic,payload,packet)=>{if(this.#closed||!this.#connected)return;const temporary=this.#waiters.receive(topic,payload),group=this.#topics.get(topic);if(!group&&!temporary)return;this.#messages++;if(topic===this.#rpcTopic)try{this.#rpcReceiver?.(payload,packet.retain,this.#rpcGeneration.signal);}catch{this.#failure='MQTT RPC receiver error';}if(group)for(const receiver of group.receivers)receiver.receive(payload);});
  for(const receiver of receivers)receiverOwners.add(receiver);
 }
 /** The server enables presence before ownership/start. Standalone sensor
  * transports do not claim a Moonraker service is online. */
 enablePresence():void{
  if(this.#started||this.#closed)throw new ApiError(409,'MQTT presence must be enabled before start');
  const topic=this.instanceName+'/moonraker/status';if(Buffer.byteLength(topic)>65535)throw new ApiError(400,'MQTT presence topic exceeds byte limit');
  this.#client.options.will={topic,payload:Buffer.from('{"server":"offline"}'),qos:this.#defaultQos,retain:true};this.#presence=true;
 }
 bindRpc(receiver:(payload:Buffer,retained:boolean,signal:AbortSignal)=>void,qos:QoS):void{
  if(this.#started||this.#closed||this.#rpcReceiver||typeof receiver!=='function')throw new ApiError(409,'MQTT RPC must bind once before start');
  const topic=this.instanceName+'/moonraker/api/request';if(Buffer.byteLength(topic)>65535)throw new ApiError(400,'MQTT RPC topic exceeds byte limit');
  const effective=(bounded(qos,0,2)||this.#defaultQos) as QoS,previous=this.#topics.get(topic);
  if(previous)previous.qos=Math.max(previous.qos,effective) as QoS;else this.#topics.set(topic,{qos:effective,receivers:[]});
  this.#rpcReceiver=receiver;this.#rpcTopic=topic;
 }
 waitForMessage(topic:string,options:MqttWaitOptions={}):Promise<Buffer>{return this.#waiters.wait(topic,options);}
 #failPublishes(error:Error):void{for(const fail of [...this.#publishes])fail(error);}
 /** QoS 0 resolves on local write, QoS 1/2 on protocol acknowledgment. Failure
  * cannot undo bytes already delivered. No offline queue or reconnect replay. */
 async publish(topic:string,payload:string|Uint8Array,options:MqttPublishOptions={}):Promise<void>{
  if(typeof topic!=='string'||!topic||!topic.isWellFormed()||Buffer.byteLength(topic)>65535||/[+#\0]/u.test(topic))throw new ApiError(400,'Invalid MQTT publish topic');
  if(typeof payload!=='string'&&!(payload instanceof Uint8Array)||typeof payload==='string'&&!payload.isWellFormed())throw new ApiError(400,'Invalid MQTT publish payload');
  const size=typeof payload==='string'?Buffer.byteLength(payload):payload.byteLength;
  if(size>65536)throw new ApiError(413,'MQTT publish payload exceeds byte limit');
  const qos=(bounded(options.qos??this.#defaultQos,0,2)||this.#defaultQos) as QoS,timeout=bounded(options.timeoutMs??10000,1,120000),retain=options.retain??false;
  if(typeof retain!=='boolean')throw new ApiError(400,'Invalid MQTT retain option');
  if(options.signal?.aborted)throw new ApiError(499,'MQTT publish cancelled');
  if(this.#closed||!this.#ready||!this.#client.connected)throw new ApiError(503,'MQTT is not ready');
  if(this.#publishes.size>=32)throw new ApiError(429,'MQTT publish capacity exceeded');
  const bytes=typeof payload==='string'?Buffer.from(payload):Buffer.from(payload);
  return new Promise<void>((resolve,reject)=>{
   let done=false,messageId:number|undefined;
   const finish=(error?:Error)=>{if(done)return;done=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);this.#publishes.delete(fail);
    if(error&&messageId!==undefined)this.#client.removeOutgoingMessage(messageId);
    if(error)reject(error);else resolve();
   };
   const fail=(error:Error)=>finish(error),abort=()=>finish(new ApiError(499,'MQTT publish cancelled; delivery may be unknown'));
   const timer=setTimeout(()=>finish(new ApiError(504,'MQTT publish timed out; delivery may be unknown')),timeout);
   this.#publishes.add(fail);options.signal?.addEventListener('abort',abort,{once:true});
   // The pinned client drains store processing before connect; bounded
   // subscriptions and at most 32 publishes leave packet IDs available.
   // Allocation is synchronous here, so capture the ID before yielding.
   try{this.#client.publish(topic,bytes,{qos,retain},error=>finish(error?new ApiError(503,'MQTT publish failed; delivery may be unknown'):undefined));if(qos)messageId=this.#client.getLastMessageId();}
   catch{finish(new ApiError(503,'MQTT publish failed; delivery may be unknown'));}
  });
 }
 #subscribed(generation:number){if(this.#closed||generation!==this.#generation)return;this.#ready=true;this.#failure=null;clearTimeout(this.#timer);this.#resolve?.();this.#resolve=undefined;this.#reject=undefined;if(this.#presence)void this.publish(this.instanceName+'/moonraker/status','{"server":"online"}',{retain:true}).then(()=>{if(!this.#closed&&generation===this.#generation)this.#presenceOnline=true;},()=>{if(!this.#closed&&generation===this.#generation)this.#presenceFailures++;});}
 owns(store:SensorStore):boolean{return [...this.#topics.values()].every(group=>group.receivers.every(receiver=>receiver.owns(store)));}
 get status(){return {started:this.#started,closed:this.#closed,connected:this.#connected,ready:this.#ready,connections:this.#connections,messages:this.#messages,waiting:this.#waiters.count,rpcBound:!!this.#rpcReceiver,failure:this.#failure,presence:{enabled:this.#presence,online:this.#presenceOnline,failures:this.#presenceFailures}};}
 start():Promise<void>{if(this.#closed)return Promise.reject(new Error('MQTT sensors are closed'));if(this.#starting)return this.#starting;
  this.#starting=new Promise<void>((resolve,reject)=>{this.#resolve=resolve;this.#reject=reject;this.#timer=setTimeout(()=>{this.#failure='MQTT startup timed out';reject(new Error(this.#failure));void this.close();},this.#timeout);this.#started=true;this.#client.connect();});return this.#starting;
 }
 async #gracefulEnd():Promise<void>{
  const deadline=setTimeout(()=>{this.#presenceFailures++;this.#client.stream.destroy();},2000);
  try{await this.#client.endAsync(false);}finally{clearTimeout(deadline);}
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;
  this.#rpcGeneration.abort();this.#waiters.disconnect();this.#failPublishes(new ApiError(503,'MQTT closed; delivery may be unknown'));
  // Start the final retained write while this generation is still writable.
  // Reject public writes immediately after; no retry or reconnect is allowed.
  this.#client.options.reconnectPeriod=0;
  const offline=this.#presence&&this.#started&&this.#ready&&this.#client.connected?this.publish(this.instanceName+'/moonraker/status','{"server":"offline"}',{retain:true,timeoutMs:2000}):undefined;
  this.#closed=true;this.#generation++;this.#connected=false;this.#ready=false;this.#presenceOnline=false;clearTimeout(this.#timer);this.#reject?.(new Error('MQTT sensors closed during startup'));this.#resolve=undefined;this.#reject=undefined;
  for(const group of this.#topics.values())for(const receiver of group.receivers){receiver.disconnect();receiver.close();}
  this.#closing=!this.#started?Promise.resolve():offline?offline.then(()=>this.#gracefulEnd(),()=>{this.#presenceFailures++;return this.#client.endAsync(true);}):this.#client.endAsync(true);
  return this.#closing;
 }
}
