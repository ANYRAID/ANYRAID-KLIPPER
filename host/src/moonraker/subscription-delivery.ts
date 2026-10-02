import {ApiError,type Json,type RpcContext} from './rpc.ts';
import {SubscriptionFilter,type StatusView} from './subscription-status.ts';
import type {SubscriptionReply} from './subscription-manager.ts';
import type {DeliveryReport} from './notifications.ts';
interface Client {id:number;signal:AbortSignal;abort:()=>void;holds:number;filter:SubscriptionFilter;time:number;queue:{status:StatusView;time:number}[];bytes:number;pending:Set<Promise<void>>;}
export interface SubscriptionDeliveryOptions {
 signal(id:number):AbortSignal;
 subscribe(id:number,objects:unknown,signal:AbortSignal):Promise<SubscriptionReply>;
 remove(id:number):void;
 send(id:number,status:StatusView,time:number):DeliveryReport|Promise<DeliveryReport>;
 enabled():boolean;
 disconnect(id:number):void;
}
/** One connection generation per client. Holds deltas until all responses for
 * that connection are handed off; drains older authorized sends before changing
 * the subscription. Pending authorization remains owned by the network queue. */
export class SubscriptionDelivery {
 #options:SubscriptionDeliveryOptions;#clients=new Map<number,Client>();#closed=false;
 constructor(options:SubscriptionDeliveryOptions){this.#options={...options};}
 get size(){return this.#clients.size;}
 #remove(client:Client){if(this.#clients.get(client.id)!==client)return;this.#clients.delete(client.id);client.signal.removeEventListener('abort',client.abort);client.queue=[];client.bytes=0;this.#options.remove(client.id);}
 #fail(client:Client){if(this.#clients.get(client.id)!==client)return;this.#remove(client);this.#options.disconnect(client.id);}
 #check(client:Client,signal:AbortSignal){signal.throwIfAborted();if(this.#closed||this.#clients.get(client.id)!==client||client.signal.aborted)throw new ApiError(503,'Subscription connection unavailable');}
 async subscribe(params:Readonly<Record<string,Json>>,context:RpcContext):Promise<Json>{
  if(this.#closed||!this.#options.enabled())throw new ApiError(503,'Authorized subscription delivery unavailable');
  if(!context.afterResponse||!(context.transport==='websocket'&&context.connectionId||context.transport==='http'&&context.subscriptionConnection))throw new ApiError(400,'HTTP or WebSocket subscription context required');
  const filter=new SubscriptionFilter(Object.hasOwn(params,'objects')?params.objects:{}),associated=context.transport==='http'?await context.subscriptionConnection!():undefined,id=associated?.id??context.connectionId!;associated?.signal.throwIfAborted();context.signal.throwIfAborted();let client=this.#clients.get(id);
  if(!client){const signal=this.#options.signal(id);signal.throwIfAborted();client={id,signal,abort:()=>this.#remove(client!),holds:0,filter:new SubscriptionFilter({}),time:-Infinity,queue:[],bytes:0,pending:new Set()};this.#clients.set(id,client);signal.addEventListener('abort',client.abort,{once:true});}
  const owner=client;owner.holds++;let finished=false;const release=(sent:boolean)=>{if(finished)return;finished=true;context.signal.removeEventListener('abort',cancel);if(!sent){this.#remove(owner);return;}owner.holds--;if(!owner.holds)this.#flush(owner);},cancel=()=>release(false);
  try{context.afterResponse(release);context.signal.addEventListener('abort',cancel,{once:true});this.#check(owner,context.signal);
   // A previously queued async authorization must settle before the new reply.
   await Promise.all([...owner.pending]);this.#check(owner,context.signal);
   const response=await this.#options.subscribe(id,filter.objects,AbortSignal.any([context.signal,owner.signal]));this.#check(owner,context.signal);owner.filter=filter;owner.time=response.eventtime;return response as unknown as Json;
  }catch(error){release(false);throw error;}
 }
 deliver(id:number,status:StatusView,time:number){const client=this.#clients.get(id);if(!client||client.signal.aborted||time<client.time)return;if(client.holds){const bytes=Buffer.byteLength(JSON.stringify(status))+8;if(client.queue.length>=256||client.bytes+bytes>1024*1024){this.#fail(client);return;}client.queue.push({status,time});client.bytes+=bytes;}else this.#send(client,status,time);}
 #send(client:Client,status:StatusView,time:number){if(this.#clients.get(client.id)!==client||time<client.time)return;const projected=client.filter.project(status);if(!Object.keys(projected).length)return;client.time=time;let promise:Promise<void>;try{const result=this.#options.send(client.id,projected,time);if(!('then' in result)){if(result.sent!==1)this.#fail(client);return;}promise=result.then(report=>{if(report.sent!==1)this.#fail(client);},()=>this.#fail(client));}catch{this.#fail(client);return;}client.pending.add(promise);void promise.then(()=>client.pending.delete(promise));}
 #flush(client:Client){if(this.#clients.get(client.id)!==client)return;const queue=client.queue.sort((a,b)=>a.time-b.time),watermark=client.time;client.queue=[];client.bytes=0;for(const update of queue)if(update.time>watermark)this.#send(client,update.status,update.time);}
 close(){this.#closed=true;for(const client of [...this.#clients.values()])this.#remove(client);}
}
