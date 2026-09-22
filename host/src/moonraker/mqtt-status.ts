// Moonraker mqtt.py status publishing semantics. GPL-3.0-or-later.
// Original Copyright (C) 2021 Eric Callahan.
import {SubscriptionFilter,type StatusView} from './subscription-status.ts';
import type {MqttPublisher} from './mqtt-api.ts';
import type {Json} from './rpc.ts';
import type {ConfigurationReader} from './config-reader.ts';
import {ConfigurationError} from './config-source.ts';
export interface MqttStatusOptions {objects:unknown;split:boolean;interval:number;}
export function readMqttStatusOptions(reader:ConfigurationReader):MqttStatusOptions{
 const section=reader.section('mqtt');
 try{
  const values=section.getDictionary('status_objects',{defaultValue:{},allowEmptyFields:true});
  const objects=Object.fromEntries(Object.entries(values).map(([name,fields])=>[name,fields===null?null:String(fields).split(',').map(s=>s.trim()).filter(Boolean)]));
  return {objects:new SubscriptionFilter(objects).objects,split:section.getBoolean('publish_split_status',{defaultValue:false}),interval:section.getFloat('status_interval',{defaultValue:0,above:.25})};
 }catch(error){reader.error('mqtt');throw new ConfigurationError('[mqtt]: Invalid status publication configuration',{cause:error});}
}
type Pending=Record<string,Record<string,Json>>;
/** One active batch plus one latest-value batch. No broker wait enters the
 * Klippy callback. Each batch has a 64 KiB encoded bound. */
export class MqttStatusPublisher {
 readonly filter:SubscriptionFilter;readonly #publisher:MqttPublisher;readonly #instance:string;readonly #split:boolean;readonly #interval:number;readonly #ready:()=>boolean;readonly #epoch:()=>number;#lastEpoch:number;
 #pending:Pending=Object.create(null);#time=0;#bytes=0;#encoded='';#abort=new AbortController();#active:Promise<void>|undefined;#timer:ReturnType<typeof setTimeout>|undefined;#due=false;#closed=false;
 #published=0;#failed=0;#rejected=0;#coalesced=0;
 constructor(publisher:MqttPublisher,instance:string,options:MqttStatusOptions,ready:()=>boolean,epoch:()=>number=()=>0){
  this.filter=new SubscriptionFilter(options.objects);this.#publisher=publisher;this.#instance=instance;this.#split=options.split;this.#interval=options.interval;this.#ready=ready;this.#epoch=epoch;this.#lastEpoch=epoch();
  if(!Number.isFinite(options.interval)||options.interval!==0&&options.interval<=.25||options.interval>2147483)throw new ConfigurationError('Invalid MQTT status interval');
 }
 get status(){return {pendingBytes:this.#bytes,active:!!this.#active,published:this.#published,failed:this.#failed,rejected:this.#rejected,coalesced:this.#coalesced,closed:this.#closed};}
 start():void{if(this.#closed||this.#timer||!this.#interval)return;this.#timer=setInterval(()=>this.flush(),this.#interval*1000);this.#timer.unref();}
 send(status:StatusView,eventtime:number):void{
  if(this.#closed||!this.#available())return;
  try{
   if(!Number.isFinite(eventtime))throw new Error('Invalid status time');
   const selected=this.filter.project(status);if(!Object.keys(selected).length)return;
   const next:Pending=Object.assign(Object.create(null),this.#pending);
   for(const [name,fields] of Object.entries(selected)){
    if(this.#split&&(/[+#\0]/u.test(name)||Object.keys(fields).some(field=>/[+#\0]/u.test(field))))throw new Error('Invalid state topic');
    next[name]=next[name]?Object.assign(Object.create(null),next[name],fields):fields;
   }
   const encoded=JSON.stringify({eventtime,status:next}),bytes=Buffer.byteLength(encoded);if(bytes>65536)throw new Error('Status capacity');
   if(this.#bytes)this.#coalesced++;
   this.#pending=next;this.#time=eventtime;this.#bytes=bytes;this.#encoded=encoded;
   if(!this.#interval)this.flush();
  }catch{this.#rejected++;}
 }
 flush():void{
  if(this.#closed)return;this.#due=true;if(this.#active||!this.#bytes)return;
  if(!this.#available()||!this.#bytes)return;
  const status=this.#pending,eventtime=this.#time,encoded=this.#encoded,signal=this.#abort.signal;this.#clear();this.#due=false;
  const run=async()=>{
   if(this.#split){for(const [object,fields] of Object.entries(status))for(const [field,value] of Object.entries(fields)){
    signal.throwIfAborted();await this.#publisher.publish(`${this.#instance}/klipper/state/${object}/${field}`,JSON.stringify({eventtime,value}),{retain:true,signal});this.#published++;
   }}else{await this.#publisher.publish(`${this.#instance}/klipper/status`,encoded,{retain:false,signal});this.#published++;}
  };
  const active=run().catch(()=>{this.#failed++;}).finally(()=>{if(this.#active===active){this.#active=undefined;if(this.#due)this.flush();}});this.#active=active;
 }
 #available(){const epoch=this.#epoch();if(epoch!==this.#lastEpoch||!this.#ready()){this.#clear();this.#abort.abort();this.#abort=new AbortController();this.#lastEpoch=epoch;}return this.#ready();}
 #clear(){this.#pending=Object.create(null);this.#bytes=0;this.#encoded='';}
 /** Generation boundaries discard pending telemetry and cancel active writes;
  * stale state must never replay after reconnect. */
 reset():void{clearInterval(this.#timer);this.#timer=undefined;this.#clear();this.#due=false;this.#abort.abort();this.#abort=new AbortController();}
 async close(){this.#closed=true;this.reset();await this.#active;}
}
