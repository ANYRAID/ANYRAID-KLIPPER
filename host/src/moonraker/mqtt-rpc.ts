// Moonraker mqtt.py API transport. GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan.
import {ApiError,JsonRpcDispatcher,type RpcContext,type Json} from './rpc.ts';
import type {MqttPublisher} from './mqtt-api.ts';
export type MqttAuthorization=(method:string,params:Readonly<Record<string,Json>>,signal:AbortSignal)=>ReturnType<RpcContext['authorize']>;
/** Explicit broker-domain authorization: MQTT packets contain no trustworthy
 * HTTP identity. Authentication/ACL policy belongs to the deployment owner. */
export class MqttRpc {
 readonly #rpc:JsonRpcDispatcher;readonly #publisher:MqttPublisher;readonly #topic:string;readonly #authorize:MqttAuthorization;readonly #qos:0|1|2;
 readonly #signals=new WeakMap<AbortSignal,AbortSignal>();readonly #owner=new AbortController();readonly #jobs=new Set<Promise<void>>();readonly #timestamps:Json[]=[];
 #received=0;#rejected=0;#failed=0;#completed=0;
 constructor(rpc:JsonRpcDispatcher,publisher:MqttPublisher,instance:string,authorize:MqttAuthorization,qos:0|1|2=0){
  if(typeof authorize!=='function'||![0,1,2].includes(qos)||typeof instance!=='string'||!instance.isWellFormed()||/[+#\0]/u.test(instance)||Buffer.byteLength(instance+'/moonraker/api/response')>65535)throw new ApiError(400,'Invalid MQTT RPC policy');
  this.#rpc=rpc;this.#publisher=publisher;this.#topic=instance+'/moonraker/api/response';this.#authorize=authorize;this.#qos=qos;
 }
 get status(){return {received:this.#received,rejected:this.#rejected,failed:this.#failed,completed:this.#completed,pending:this.#jobs.size,closed:this.#owner.signal.aborted};}
 receive=(payload:Buffer,retained:boolean,generation:AbortSignal):void=>{
  if(this.#owner.signal.aborted||generation.aborted)return;this.#received++;
  // Retained control packets are stale work, not commands to replay on startup.
  if(retained||payload.byteLength>65536||this.#jobs.size>=16){this.#rejected++;return;}
  let signal=this.#signals.get(generation);if(!signal){signal=AbortSignal.any([this.#owner.signal,generation]);this.#signals.set(generation,signal);}
  const bytes=Buffer.from(payload),callbacks:((sent:boolean)=>void)[]=[];
  const context:RpcContext={transport:'mqtt',signal,afterResponse:callback=>{if(callbacks.length>=256)throw new ApiError(429,'MQTT response callback capacity exceeded');callbacks.push(callback);},authorize:async(method,params)=>{
   const timestamp=params.mqtt_timestamp;
   // Parameters belong exclusively to this dispatch. Strip the transport field
   // before application authorization and invocation, as upstream does.
   delete (params as Record<string,Json>).mqtt_timestamp;
   if(timestamp!==undefined&&timestamp!==null&&(typeof timestamp!=='number'&&typeof timestamp!=='string'||typeof timestamp==='string'&&Buffer.byteLength(timestamp)>256))throw new ApiError(400,'Invalid MQTT timestamp');
   const identity=await this.#authorize(method,params,signal);signal.throwIfAborted();
   if(timestamp!==undefined&&timestamp!==null){if(this.#timestamps.includes(timestamp))throw new ApiError(-10000,'Duplicate MQTT Request');this.#timestamps.push(timestamp);if(this.#timestamps.length>20)this.#timestamps.shift();}
   return identity;
  }};
  let sent=false;
  const job=this.#rpc.dispatch(bytes,context).then(async response=>{signal.throwIfAborted();if(response!==null){if(Buffer.byteLength(response)>65536)throw new ApiError(413,'MQTT response exceeds byte limit');await this.#publisher.publish(this.#topic,response,{qos:this.#qos,signal});sent=true;}this.#completed++;}).catch(()=>{this.#failed++;}).finally(()=>{this.#jobs.delete(job);for(const callback of callbacks)try{callback(sent&&!signal.aborted);}catch{this.#failed++;}});
  this.#jobs.add(job);
 };
 async close(){this.#owner.abort();await Promise.allSettled([...this.#jobs]);}
}
