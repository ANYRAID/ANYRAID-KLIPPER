import {ApiError} from './rpc.ts';
import {NativeObjects} from './native-objects.ts';
import {SubscriptionFilter,mergeSubscriptions,adoptStatus,statusDifference,type StatusView} from './subscription-status.ts';
import type {SubscriptionReply} from './subscription-manager.ts';
interface Client {filter:SubscriptionFilter;previous:StatusView;}
function unionFilters(filters:SubscriptionFilter[]){const union=mergeSubscriptions(filters);if(Object.values(union.objects).reduce((sum,fields)=>sum+(fields?.length??0),0)>16384)throw new ApiError(429,'Native subscription field capacity exceeded');return union;}
function resolveFields(filter:SubscriptionFilter,status:StatusView){return new SubscriptionFilter(Object.fromEntries(Object.entries(filter.objects).map(([name,fields])=>[name,fields??(Object.keys(status[name]).length?Object.keys(status[name]):null)])));}
export interface NativeSubscriptionOptions {
 deliver(id:number,status:StatusView,eventtime:number):void;
 disconnect(id:number):void;
}
/** Native counterpart of klippy/webhooks.py QueryStatusHelper. One shared
 * 250ms sampling cycle, no timer while idle, immutable per-client baselines.
 * Delivery must be owned by SubscriptionDelivery, not a raw socket callback. */
export class NativeSubscriptions {
 #objects:NativeObjects;#options:NativeSubscriptionOptions;#clients=new Map<number,Client>();#union=new SubscriptionFilter({});#timer:ReturnType<typeof setTimeout>|undefined;#closed=false;#samples=0;#failures=0;
 constructor(objects:NativeObjects,options:NativeSubscriptionOptions){this.#objects=objects;this.#options={...options};}
 get metrics(){return {clients:this.#clients.size,sampling:this.#timer!==undefined,closed:this.#closed,samples:this.#samples,failures:this.#failures};}
 async subscribe(id:number,objects:unknown,signal?:AbortSignal):Promise<SubscriptionReply>{
  if(this.#closed)throw new ApiError(503,'Native subscriptions closed');signal?.throwIfAborted();if(!Number.isSafeInteger(id)||id<1)throw new ApiError(400,'Invalid subscription client');
  const requested=new SubscriptionFilter(objects),active=Object.keys(requested.objects).length>0;if(active&&!this.#clients.has(id)&&this.#clients.size>=256)throw new ApiError(429,'Native subscription client capacity exceeded');
  // Validate aggregate capacity before sampling. Never mutate a live subscription
  // until its replacement snapshot and union have both succeeded.
  const others=[...this.#clients].filter(([key])=>key!==id).map(([,client])=>client.filter);
  unionFilters([...others,requested]);
  const reply=this.#objects.query(requested.objects),status=adoptStatus(reply.status);
  // Python resolves a nonempty null selection to the initial field names.
  const filter=resolveFields(requested,status),union=unionFilters([...others,filter]);
  signal?.throwIfAborted();if(active)this.#clients.set(id,{filter,previous:status});else this.#clients.delete(id);this.#union=union;this.#schedule();
  return {eventtime:reply.eventtime,status};
 }
 remove(id:number){if(!this.#clients.delete(id))return;this.#union=mergeSubscriptions([...this.#clients.values()].map(client=>client.filter));this.#schedule();}
 #schedule(){if(!this.#clients.size||this.#closed){clearTimeout(this.#timer);this.#timer=undefined;}else if(!this.#timer)this.#timer=setTimeout(()=>{this.#timer=undefined;this.sample();this.#schedule();},250).unref();}
 /** One synchronous sampling cycle; exposed for deterministic timing tests. */
 sample(){
  if(this.#closed||!this.#clients.size)return;
  let status:StatusView,eventtime:number;try{const reply=this.#objects.query(this.#union.objects);status=adoptStatus(reply.status);eventtime=reply.eventtime;this.#samples++;}catch{this.#failures++;const ids=[...this.#clients.keys()];this.#clients.clear();this.#union=new SubscriptionFilter({});this.#schedule();for(const id of ids)this.#disconnect(id);return;}
  let resolved=false;for(const [id,client] of [...this.#clients]){if(this.#clients.get(id)!==client)continue;const selected=client.filter.project(status,true),delta=statusDifference(selected,client.previous);client.previous=selected;
   if(Object.entries(client.filter.objects).some(([name,fields])=>fields===null&&Object.keys(selected[name]).length)){client.filter=resolveFields(client.filter,selected);resolved=true;}
   if(Object.keys(delta).length)try{this.#options.deliver(id,delta,eventtime);}catch{this.remove(id);this.#disconnect(id);}}
  if(resolved)try{this.#union=unionFilters([...this.#clients.values()].map(client=>client.filter));}catch{this.#failures++;const ids=[...this.#clients.keys()];this.#clients.clear();this.#union=new SubscriptionFilter({});this.#schedule();for(const id of ids)this.#disconnect(id);}
 }
 #disconnect(id:number){try{this.#options.disconnect(id);}catch{/* Network cleanup cannot escape the sampling timer. */}}
 close(){if(this.#closed)return;this.#closed=true;this.#clients.clear();this.#union=new SubscriptionFilter({});this.#schedule();}
}
