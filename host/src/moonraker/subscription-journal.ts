import {ApiError,type Json} from './rpc.ts';
import {SubscriptionFilter,prepareStatus,type StatusView} from './subscription-status.ts';
export interface SubscriptionJournalLimits {updates?:number;bytes?:number;}
/** Bounded, requested-field-only deltas received while the snapshot is in flight.
 * Event time orders values; equal times retain wire arrival order. */
export class SubscriptionJournal {
 #filter:SubscriptionFilter;#updates:{status:StatusView;eventtime:number}[]=[];#bytes=0;#maxUpdates:number;#maxBytes:number;
 constructor(filter:SubscriptionFilter,limits:SubscriptionJournalLimits={}){this.#filter=filter;this.#maxUpdates=limits.updates??256;this.#maxBytes=limits.bytes??1024*1024;for(const [value,max] of [[this.#maxUpdates,10000],[this.#maxBytes,64*1024*1024]])if(!Number.isSafeInteger(value)||value<1||value>max)throw new ApiError(400,'Invalid subscription journal limit');}
 get metrics(){return {updates:this.#updates.length,bytes:this.#bytes};}
 append(status:StatusView,eventtime:number):void{if(!Number.isFinite(eventtime))throw new ApiError(502,'Invalid subscription event time');const projected=this.#filter.project(status);if(!Object.keys(projected).length)return;const bytes=Buffer.byteLength(JSON.stringify(projected))+8;if(this.#updates.length>=this.#maxUpdates||this.#bytes+bytes>this.#maxBytes)throw new ApiError(429,'Subscription snapshot journal capacity exceeded');this.#updates.push({status:projected,eventtime});this.#bytes+=bytes;}
 reconcile(snapshot:StatusView,eventtime:number):{status:StatusView;eventtime:number}{if(!Number.isFinite(eventtime))throw new ApiError(502,'Invalid subscription event time');const initial=this.#filter.project(snapshot,true),updates=this.#updates.filter(update=>update.eventtime>=eventtime).sort((a,b)=>a.eventtime-b.eventtime);if(!updates.length)return {status:initial,eventtime};
  const merged:Record<string,Record<string,Json>>=Object.create(null);for(const [object,fields] of Object.entries(initial))merged[object]=Object.assign(Object.create(null),fields);for(const update of updates){for(const [object,fields] of Object.entries(update.status)){merged[object]??=Object.create(null);Object.assign(merged[object],fields);}eventtime=Math.max(eventtime,update.eventtime);}return {status:prepareStatus(merged),eventtime};
 }
}
