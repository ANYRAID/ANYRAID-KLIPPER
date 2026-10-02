import {mqttPublishPayload,type MqttPublisher} from './mqtt-api.ts';
import type {KlippyMethod} from './klippy-socket.ts';
/** Klippy's callback is fire-and-forget. MQTT failure must not tear down the
 * printer connection or occupy its callback deadline while awaiting a broker. */
export class MqttMacroPublisher {
 readonly #publisher:MqttPublisher;readonly #prefix:string;readonly #owner=new AbortController();readonly #jobs=new Set<Promise<void>>();
 #received=0;#completed=0;#failed=0;#rejected=0;#cancelled=0;
 constructor(publisher:MqttPublisher,instanceName:string){this.#publisher=publisher;this.#prefix=instanceName;}
 readonly invoke:KlippyMethod=(params,generation)=>{
  this.#received++;
  if(this.#owner.signal.aborted||generation.aborted){this.#cancelled++;return;}
  if(this.#jobs.size>=32){this.#rejected++;return;}
  const {topic,payload,qos,retain=false,use_prefix=false}=params;
  if(typeof topic!=='string'||typeof retain!=='boolean'||typeof use_prefix!=='boolean'||qos!=null&&!(typeof qos==='boolean'||typeof qos==='number'&&Number.isInteger(qos)&&qos>=0&&qos<=2)){this.#rejected++;return;}
  let text:string;try{text=mqttPublishPayload(payload);}catch{this.#rejected++;return;}
  const signal=AbortSignal.any([generation,this.#owner.signal]),effective=use_prefix?`${this.#prefix}/${topic.replace(/^\/+/, '')}`:topic;
  // Promise scheduling also converts synchronous publisher throws into a
  // recorded failure, never an uncaught Klippy callback exception.
  const job=Promise.resolve().then(()=>{signal.throwIfAborted();return this.#publisher.publish(effective,text,{qos:qos==null?undefined:Number(qos) as 0|1|2,retain,signal});}).then(()=>{this.#completed++;},()=>{if(signal.aborted)this.#cancelled++;else this.#failed++;}).finally(()=>this.#jobs.delete(job));
  this.#jobs.add(job);
 };
 get status(){return {received:this.#received,completed:this.#completed,failed:this.#failed,rejected:this.#rejected,cancelled:this.#cancelled,pending:this.#jobs.size,closed:this.#owner.signal.aborted};}
 async close():Promise<void>{this.#owner.abort();await Promise.allSettled([...this.#jobs]);}
}
