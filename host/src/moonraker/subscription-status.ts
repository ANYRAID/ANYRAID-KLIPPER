// Subscription union, projection and cache rules follow pinned Moonraker
// klippy_connection.py. Prepared immutable views are shared across recipients.
import {ApiError,validateJson,type Json} from './rpc.ts';
export type Subscription=Readonly<Record<string,readonly string[]|null>>;
export type StatusView=Readonly<Record<string,Readonly<Record<string,Json>>>>;
const prepared=new WeakSet<object>();
const record=(v:unknown):v is Record<string,Json>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function name(value:string){if(!value||value.length>256||value.includes('\0'))throw new ApiError(400,'Invalid subscription name');}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const child of Object.values(v))freeze(child);Object.freeze(v);}return v;}
function put<T>(target:Record<string,T>,key:string,value:T){if(key==='__proto__')Object.defineProperty(target,key,{value,enumerable:true,configurable:true,writable:true});else target[key]=value;}
function cloneFrozen(value:Json):Json{if(value===null||typeof value!=='object')return value;const copy:any=Array.isArray(value)?new Array(value.length):{};for(const key of Object.keys(value))put(copy,key,cloneFrozen((value as Record<string,Json>)[key]));return Object.freeze(copy);}
function owned(value:Record<string,Readonly<Record<string,Json>>>):StatusView{const view=Object.freeze(value);prepared.add(view);return view;}
function requirePrepared(status:StatusView){if(!prepared.has(status))throw new TypeError('Status must be prepared before projection or caching');}
function checkStatus(value:unknown):void{
 try{validateJson(value);if(!record(value)||Object.keys(value).length>4096)throw new Error();for(const [key,fields] of Object.entries(value)){name(key);if(!record(fields))throw new Error();for(const field of Object.keys(fields))name(field);}}catch{throw new ApiError(502,'Invalid Klippy status structure');}
}
export function prepareStatus(value:unknown):StatusView{checkStatus(value);return owned(cloneFrozen(value as Json) as Record<string,Readonly<Record<string,Json>>>);}
/** Consume exclusively owned decoded input. The caller relinquishes mutation
 * rights; external/shared inputs must use prepareStatus() instead. */
export function adoptStatus(value:unknown):StatusView{checkStatus(value);return owned(freeze(value) as Record<string,Readonly<Record<string,Json>>>);}
/** Compile once on subscription changes, not once per status update. */
export class SubscriptionFilter {
 readonly objects:Subscription;#entries:readonly (readonly [string,readonly string[]|null])[];
 constructor(value:unknown){try{validateJson(value);}catch{throw new ApiError(400,'Invalid object subscription');}if(!record(value)||Object.keys(value).length>4096)throw new ApiError(400,'Invalid object subscription');const entries:[string,string[]|null][]=[];
  for(const [key,fields] of Object.entries(value)){name(key);if(fields!==null&&(!Array.isArray(fields)||fields.length>4096||fields.some(f=>typeof f!=='string')))throw new ApiError(400,'Subscription fields must be a string list or null');const values=fields===null?null:[...new Set(fields as string[])];if(values)for(const field of values)name(field);entries.push([key,values]);}
  this.objects=freeze(Object.fromEntries(entries));this.#entries=entries.map(([key,fields])=>[key,fields] as const);Object.freeze(this);
 }
 project(status:StatusView,includeEmpty=false):StatusView{requirePrepared(status);const selected:Record<string,Readonly<Record<string,Json>>>={};for(const [key,fields] of this.#entries){if(!Object.hasOwn(status,key))continue;const source=status[key];if(fields===null){if(includeEmpty||Object.keys(source).length)put(selected,key,source);}else{const value:Record<string,Json>={};let count=0;for(const field of fields)if(Object.hasOwn(source,field)){put(value,field,source[field]);count++;}if(includeEmpty||count)put(selected,key,Object.freeze(value));}}return owned(selected);}
}
export function mergeSubscriptions(subscriptions:Iterable<SubscriptionFilter>):SubscriptionFilter{
 const merged=new Map<string,Set<string>|null>();let fieldsCount=0;
 for(const subscription of subscriptions)for(const [key,fields] of Object.entries(subscription.objects)){
  if(!merged.has(key)){merged.set(key,fields===null?null:new Set(fields));fieldsCount+=fields?.length??0;}
  else{const previous=merged.get(key)!;if(previous!==null){if(fields===null){fieldsCount-=previous.size;merged.set(key,null);}else{const before=previous.size;for(const field of fields)previous.add(field);fieldsCount+=previous.size-before;}}}
  if(merged.size>4096||fieldsCount>100000)throw new ApiError(429,'Combined subscription capacity exceeded');
 }
 return new SubscriptionFilter(Object.fromEntries([...merged].map(([key,fields])=>[key,fields===null?null:[...fields]])));
}
/** Python JSON equality: booleans compare numerically, -0 equals 0, mapping
 * insertion order is irrelevant; arrays remain ordered. Values are validated. */
function equal(a:Json,b:Json):boolean{if(a===b)return true;if(typeof a==='boolean'&&typeof b==='number'||typeof a==='number'&&typeof b==='boolean')return Number(a)===Number(b);if(Array.isArray(a)&&Array.isArray(b))return a.length===b.length&&a.every((v,i)=>equal(v,b[i]));if(record(a)&&record(b)){const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(k=>Object.hasOwn(b,k)&&equal(a[k],b[k]));}return false;}
/** Klippy subscription comparisons use missing previous values as None.
 * Both inputs and all shared output values have immutable ownership. */
export function statusDifference(current:StatusView,previous:StatusView):StatusView{
 requirePrepared(current);requirePrepared(previous);const changes:Record<string,Readonly<Record<string,Json>>>={};
 for(const [object,fields] of Object.entries(current)){const before=Object.hasOwn(previous,object)?previous[object]:{},delta:Record<string,Json>={};for(const [field,value] of Object.entries(fields))if(!equal(value,Object.hasOwn(before,field)?before[field]:null))put(delta,field,value);if(Object.keys(delta).length)put(changes,object,Object.freeze(delta));}
 return owned(changes);
}
interface Entry {fields:Readonly<Record<string,Json>>;costs:ReadonlyMap<string,number>;bytes:number;}
export interface StatusCacheLimits {objects?:number;fields?:number;bytes?:number;}
function limit(value:number|undefined,fallback:number,max:number){const n=value??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'Invalid status cache limit');return n;}
const excluded=(object:string,field:string)=>object==='configfile'&&(field==='config'||field==='settings');
const fieldCost=(field:string,value:Json)=>Buffer.byteLength(JSON.stringify(field))+Buffer.byteLength(JSON.stringify(value))+2;
/** Limits account for an upper bound on encoded cache bytes, not heap/RSS.
 * Updates and replacement are atomic; stale snapshot replacement is rejected. */
export class KlippyStatusCache {
 #entries=new Map<string,Entry>();#fields=0;#bytes=2;#revision=0;#maxObjects:number;#maxFields:number;#maxBytes:number;
 constructor(limits:StatusCacheLimits={}){this.#maxObjects=limit(limits.objects,4096,100000);this.#maxFields=limit(limits.fields,100000,1000000);this.#maxBytes=limit(limits.bytes,16*1024*1024,64*1024*1024);if(this.#maxBytes<2)throw new ApiError(400,'Invalid status cache limit');}
 get revision(){return this.#revision;}
 get metrics(){return {revision:this.#revision,objects:this.#entries.size,fields:this.#fields,bytes:this.#bytes};}
 read():StatusView{return owned(Object.fromEntries([...this.#entries].map(([key,entry])=>[key,entry.fields])));}
 clear(){this.#entries.clear();this.#fields=0;this.#bytes=2;this.#revision++;}
 #entry(key:string,fields:Readonly<Record<string,Json>>,previous?:Entry):Entry{
  let next:Record<string,Json>|undefined,costs:Map<string,number>|undefined,bytes=previous?.bytes??Buffer.byteLength(JSON.stringify(key))+4;
  for(const [field,value] of Object.entries(fields)){
   if(excluded(key,field)||previous&&Object.hasOwn(previous.fields,field)&&Object.is(previous.fields[field],value))continue;
   next??={...previous?.fields};costs??=new Map(previous?.costs);const cost=fieldCost(field,value);bytes+=cost-(costs.get(field)??0);costs.set(field,cost);put(next,field,value);
  }
  if(!next&&previous)return previous;
  return {fields:Object.freeze(next??{}),costs:costs??new Map(),bytes};
 }
 #check(objects:number,fields:number,bytes:number){if(objects>this.#maxObjects||fields>this.#maxFields||bytes>this.#maxBytes)throw new ApiError(429,'Klippy status cache capacity exceeded');}
 apply(status:StatusView):void{requirePrepared(status);const updates=new Map<string,Entry>();let fields=this.#fields,bytes=this.#bytes,objects=this.#entries.size;for(const [key,value] of Object.entries(status)){const previous=this.#entries.get(key),next=this.#entry(key,value,previous);updates.set(key,next);fields+=next.costs.size-(previous?.costs.size??0);bytes+=next.bytes-(previous?.bytes??0);if(!previous)objects++;}this.#check(objects,fields,bytes);for(const [key,value] of updates)this.#entries.set(key,value);this.#fields=fields;this.#bytes=bytes;this.#revision++;}
 replace(status:StatusView,expectedRevision=this.#revision):{applied:boolean;difference:StatusView}{requirePrepared(status);if(expectedRevision!==this.#revision)return {applied:false,difference:owned({})};const next=new Map<string,Entry>(),difference:Record<string,Readonly<Record<string,Json>>>=Object.create(null);let fields=0,bytes=2;
  for(const [key,value] of Object.entries(status)){const old=this.#entries.get(key),entry=this.#entry(key,value);next.set(key,entry);fields+=entry.costs.size;bytes+=entry.bytes;if(old){const changes:Record<string,Json>=Object.create(null);for(const [field,item] of Object.entries(value))if(Object.hasOwn(old.fields,field)&&!equal(old.fields[field],item))changes[field]=item;if(Object.keys(changes).length)difference[key]=Object.freeze(changes);}}
  this.#check(next.size,fields,bytes);this.#entries=next;this.#fields=fields;this.#bytes=bytes;this.#revision++;return {applied:true,difference:owned(difference)};
 }
}
