import {MqttStatusPublisher,type MqttStatusOptions} from './mqtt-status.ts';
import type {MqttSensors} from './mqtt-sensors.ts';
import type {KlippyLifecycle} from './klippy-lifecycle.ts';
import type {StatusView} from './subscription-status.ts';
import {componentSubscriptions} from './component-subscriptions.ts';
/** Owns subscription initialization, timer and cancellation for each Klippy
 * generation. Initial subscription journals include updates during setup. */
export class MqttStatusRuntime {
 readonly publisher:MqttStatusPublisher;readonly #seen=new WeakSet<KlippyLifecycle>();
 #runtime:KlippyLifecycle|undefined;#initialized=false;#closed=false;#pending:Promise<void>|undefined;#error=false;#abort=new AbortController();
 constructor(transport:MqttSensors,options:MqttStatusOptions){this.publisher=new MqttStatusPublisher(transport,transport.instanceName,options,()=>transport.status.ready,()=>transport.status.connections);}
 get status(){return {...this.publisher.status,initialized:this.#initialized,initializationFailed:this.#error};}
 ready(runtime:KlippyLifecycle){
  if(this.#closed||this.#seen.has(runtime)||!Object.keys(this.publisher.filter.objects).length)return;
  this.#seen.add(runtime);this.#runtime=runtime;this.#initialized=false;this.publisher.reset();
  const signal=AbortSignal.any([runtime.signal,this.#abort.signal]);
  signal.addEventListener('abort',()=>{if(this.#runtime===runtime){this.#initialized=false;this.publisher.reset();}},{once:true});
  const pending=runtime.subscribeComponent(componentSubscriptions.mqttStatus,this.publisher.filter.objects,signal).then(reply=>{
   if(signal.aborted||this.#runtime!==runtime)return;this.#initialized=true;this.#error=false;this.publisher.send(reply.status,reply.eventtime);this.publisher.start();
  }).catch(()=>{if(!signal.aborted&&this.#runtime===runtime)this.#error=true;}).finally(()=>{if(this.#pending===pending)this.#pending=undefined;});this.#pending=pending;
 }
 send(status:StatusView,eventtime:number){if(this.#initialized&&!this.#closed)this.publisher.send(status,eventtime);}
 async close(){this.#closed=true;this.#abort.abort();this.#runtime?.removeSubscription(componentSubscriptions.mqttStatus);await Promise.all([this.#pending,this.publisher.close()]);}
}
