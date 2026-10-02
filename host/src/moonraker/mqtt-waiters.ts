import type {MqttClient} from 'mqtt';
import {ApiError} from './rpc.ts';
type QoS=0|1|2;
export interface MqttWaitOptions {qos?:QoS;timeoutMs?:number;signal?:AbortSignal;}
type Waiter=(error?:Error,payload?:Buffer)=>void;
interface Group {qos:QoS;revision:number;waiters:Set<Waiter>;}
/** One-shot exact-topic subscriptions shared with fixed sensor bindings.
 * Like upstream, QoS only increases while fixed handles remain registered. */
export class MqttMessageWaiters {
 readonly #client:MqttClient;readonly #fixed:ReadonlyMap<string,{qos:QoS}>;readonly #ready:()=>boolean;readonly #defaultQos:QoS;readonly #controlTimeout:number;
 readonly #groups=new Map<string,Group>();readonly #controls=new Set<ReturnType<typeof setTimeout>>();#count=0;#generation=0;
 constructor(client:MqttClient,fixed:ReadonlyMap<string,{qos:QoS}>,ready:()=>boolean,defaultQos:QoS,controlTimeout:number){this.#client=client;this.#fixed=fixed;this.#ready=ready;this.#defaultQos=defaultQos;this.#controlTimeout=controlTimeout;}
 get count(){return this.#count;}
 #control(send:(done:(error?:Error)=>void)=>void,done:(error?:Error)=>void):void{
  if(this.#controls.size>=64){this.#client.stream.destroy(new Error('MQTT control capacity exceeded'));done(new ApiError(429,'MQTT subscription capacity exceeded'));return;}
  const generation=this.#generation;let active=true;const timer=setTimeout(()=>{if(!active)return;active=false;this.#controls.delete(timer);this.#client.stream.destroy(new Error('MQTT control acknowledgment timed out'));},this.#controlTimeout);
  this.#controls.add(timer);
  const finish=(error?:Error)=>{if(!active)return;active=false;clearTimeout(timer);this.#controls.delete(timer);if(generation===this.#generation)done(error);};
  try{send(finish);}catch{finish(new ApiError(503,'MQTT subscription operation failed'));}
 }
 async wait(topic:string,options:MqttWaitOptions={}):Promise<Buffer>{
  if(typeof topic!=='string'||!topic||!topic.isWellFormed()||Buffer.byteLength(topic)>65535||/[+#\0]/u.test(topic))throw new ApiError(400,'Invalid MQTT subscription topic');
  const requested=options.qos??this.#defaultQos,timeout=options.timeoutMs??10000;
  if(!Number.isInteger(requested)||requested<0||requested>2||!Number.isSafeInteger(timeout)||timeout<1||timeout>120000)throw new ApiError(400,'Invalid MQTT subscription options');
  if(options.signal?.aborted)throw new ApiError(499,'MQTT subscription cancelled');
  if(!this.#ready())throw new ApiError(503,'MQTT is not ready');if(this.#count>=32)throw new ApiError(429,'MQTT subscription capacity exceeded');
  const qos=(requested||this.#defaultQos) as QoS,fixed=this.#fixed.get(topic),previous=this.#groups.get(topic);
  const previousQos=previous?.qos??fixed?.qos??-1,subscribe=qos>previousQos;
  const group=previous??{qos:Math.max(qos,previousQos) as QoS,revision:0,waiters:new Set<Waiter>()};
  group.qos=Math.max(group.qos,qos) as QoS;this.#groups.set(topic,group);if(fixed)fixed.qos=Math.max(fixed.qos,group.qos) as QoS;
  const generation=this.#generation;
  return new Promise<Buffer>((resolve,reject)=>{
   let active=true;
   const finish:Waiter=(error,payload)=>{if(!active)return;active=false;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);group.waiters.delete(finish);this.#count--;
    if(!group.waiters.size&&this.#groups.get(topic)===group){this.#groups.delete(topic);if(!fixed&&this.#ready())this.#control(done=>this.#client.unsubscribe(topic,error=>done(error??undefined)),error=>{if(error&&this.#ready())this.#client.stream.destroy(new Error('MQTT unsubscribe failed'));});}
    if(error)reject(error);else resolve(Buffer.from(payload!));
   };
   const abort=()=>finish(new ApiError(499,'MQTT subscription cancelled')),timer=setTimeout(()=>finish(new ApiError(504,'MQTT Subscribe Timed Out')),timeout);
   this.#count++;group.waiters.add(finish);options.signal?.addEventListener('abort',abort,{once:true});
   if(subscribe){const revision=++group.revision;
    this.#control(done=>this.#client.subscribe(topic,{qos:group.qos},(error,grants)=>done(error??(!grants||grants.length!==1||grants[0].qos>2?new Error('MQTT subscription rejected'):undefined))),error=>{
     if(error&&generation===this.#generation&&this.#groups.get(topic)===group&&group.revision===revision)for(const waiter of [...group.waiters])waiter(new ApiError(503,'MQTT subscription rejected'));
    });
   }
  });
 }
 receive(topic:string,payload:Buffer):boolean{
  const group=this.#groups.get(topic);if(!group)return false;
  const error=payload.byteLength>65536?new ApiError(413,'MQTT subscription payload exceeds byte limit'):undefined;
  for(const waiter of [...group.waiters])waiter(error,payload);return true;
 }
 disconnect():void{
  this.#generation++;for(const timer of this.#controls)clearTimeout(timer);this.#controls.clear();const groups=[...this.#groups.values()];this.#groups.clear();
  for(const group of groups)for(const waiter of [...group.waiters])waiter(new ApiError(503,'MQTT subscription connection closed'));
 }
}
