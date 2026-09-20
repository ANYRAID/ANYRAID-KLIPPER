import {ApiError,type Json} from './rpc.ts';
import {SubscriptionFilter,mergeSubscriptions,prepareStatus,KlippyStatusCache,type Subscription,type StatusView} from './subscription-status.ts';
export interface SubscriptionReply {status:StatusView;eventtime:number;}
export interface SubscriptionManagerOptions {
 request(objects:Subscription,signal:AbortSignal):Promise<unknown>;
 /** Synchronous handoff to an owner that enforces recipient authorization,
  * ordering and output budgets. This is not a raw network send API. */
 deliver(client:number,status:StatusView,eventtime:number):void;
 onSnapshotDifference?(status:StatusView,eventtime:number):void;
 cache:KlippyStatusCache;
 base?:Subscription;
 maxPending?:number;
 maxClients?:number;
}
interface Job {client:number;filter:SubscriptionFilter;controller:AbortController;resolve(value:SubscriptionReply):void;reject(reason:unknown):void;cleanup():void;settled:boolean;}
/** Serializes aggregate changes; only successful, still-live requests commit.
 * Cancellation never replays a possibly executed request. Peer supersets left
 * by cancellation/removal are pruned by the next successful transaction. */
export class SubscriptionManager {
 #options:SubscriptionManagerOptions;#base:SubscriptionFilter;#clients=new Map<number,SubscriptionFilter>();#queue:Job[]=[];#active:Job|undefined;#closed=false;#pending:number;#maxClients:number;#drain:Promise<void>|undefined;#drained:(()=>void)|undefined;
 constructor(options:SubscriptionManagerOptions){this.#options={...options};this.#base=new SubscriptionFilter(options.base??{});this.#pending=options.maxPending??32;this.#maxClients=options.maxClients??10000;for(const n of [this.#pending,this.#maxClients])if(!Number.isSafeInteger(n)||n<1||n>10000)throw new ApiError(400,'Invalid subscription manager limit');}
 get metrics(){return {clients:this.#clients.size,pending:this.#queue.length+(this.#active?1:0),closed:this.#closed};}
 subscribe(client:number,objects:unknown,signal?:AbortSignal):Promise<SubscriptionReply>{
  try{if(this.#closed)throw new ApiError(503,'Subscriptions closed');if(!Number.isSafeInteger(client)||client<1)throw new ApiError(400,'Invalid subscription client');if(signal?.aborted)throw new ApiError(499,'Subscription cancelled');if(this.metrics.pending>=this.#pending)throw new ApiError(429,'Subscription queue full');const filter=new SubscriptionFilter(objects);
   return new Promise((resolve,reject)=>{const controller=new AbortController(),cancel=()=>this.#cancel(job,new ApiError(499,'Subscription cancelled')),job:Job={client,filter,controller,resolve,reject,cleanup:()=>signal?.removeEventListener('abort',cancel),settled:false};signal?.addEventListener('abort',cancel,{once:true});this.#queue.push(job);this.#pump();});
  }catch(error){return Promise.reject(error);}
 }
 #finish(job:Job,error?:unknown,value?:SubscriptionReply){if(job.settled)return;job.settled=true;job.cleanup();if(error!==undefined)job.reject(error);else job.resolve(value!);}
 #cancel(job:Job,reason:unknown){job.controller.abort(reason);this.#finish(job,reason);if(job!==this.#active){const i=this.#queue.indexOf(job);if(i>=0)this.#queue.splice(i,1);}}
 remove(client:number):void{this.#clients.delete(client);for(const job of [...this.#queue,...(this.#active?[this.#active]:[])])if(job.client===client)this.#cancel(job,new ApiError(499,'Subscription client removed'));}
 /** Input must already be prepared; cache application belongs to the status
  * lifecycle owner so each incoming delta is cached exactly once. */
 publish(status:StatusView,eventtime:number,excluded?:number):void{if(this.#closed)return;if(!Number.isFinite(eventtime))throw new ApiError(502,'Invalid status event time');for(const [client,filter] of this.#clients){if(client===excluded)continue;const projected=filter.project(status);if(Object.keys(projected).length)this.#options.deliver(client,projected,eventtime);}}
 #pump(){if(this.#active||this.#closed)return;const job=this.#queue.shift();if(!job)return;this.#active=job;void this.#run(job).then(value=>this.#finish(job,undefined,value),error=>this.#finish(job,error)).finally(()=>{this.#active=undefined;if(this.#closed)this.#drained?.();else this.#pump();});}
 async #run(job:Job):Promise<SubscriptionReply>{
  const {client,filter,controller}=job;controller.signal.throwIfAborted();const subscribing=Object.keys(filter.objects).length>0;if(subscribing&&!this.#clients.has(client)&&this.#clients.size>=this.#maxClients)throw new ApiError(429,'Subscription client capacity exceeded');
  const others=[...this.#clients].filter(([id])=>id!==client).map(([,value])=>value),union=mergeSubscriptions([this.#base,filter,...others]),revision=this.#options.cache.revision;
  const result=await this.#options.request(union.objects,controller.signal);controller.signal.throwIfAborted();
  if(!result||typeof result!=='object'||Array.isArray(result))throw new ApiError(502,'Invalid subscription response');const reply=result as Record<string,Json>;if(typeof reply.eventtime!=='number'||!Number.isFinite(reply.eventtime))throw new ApiError(502,'Invalid subscription event time');
  const status=prepareStatus(reply.status),replacement=this.#options.cache.replace(status,revision);
  // A removed client cannot be resurrected by a late response. The transaction
  // commits before callback handoff, so delivery failure cannot roll it back.
  if(subscribing)this.#clients.set(client,filter);else this.#clients.delete(client);
  if(replacement.applied){this.#options.onSnapshotDifference?.(replacement.difference,reply.eventtime);this.publish(replacement.difference,reply.eventtime,client);}
  return {status:filter.project(status,true),eventtime:reply.eventtime};
 }
 close():Promise<void>{if(!this.#closed){this.#closed=true;this.#clients.clear();for(const job of [...this.#queue,...(this.#active?[this.#active]:[])])this.#cancel(job,new ApiError(503,'Subscriptions closed'));}if(!this.#active)return Promise.resolve();return this.#drain??=new Promise(resolve=>{this.#drained=resolve;});}
}
