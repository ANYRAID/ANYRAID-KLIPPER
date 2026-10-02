import {ApiError,validateJson,type Json} from './rpc.ts';
import {SubscriptionFilter} from './subscription-status.ts';
import {boundedJsonBytes} from './json-size.ts';
import {EndpointRegistry} from './endpoints.ts';
function put(target:Record<string,Json>,key:string,value:Json){if(key==='__proto__')Object.defineProperty(target,key,{value,enumerable:true,writable:true,configurable:true});else target[key]=value;}
function copy(value:Json):Json{if(value===null||typeof value!=='object')return value;if(Array.isArray(value))return value.map(copy);const result:Record<string,Json>={};for(const key of Object.keys(value))put(result,key,copy(value[key]));return result;}
export type NativeObjectReader=(eventtime:number)=>Readonly<Record<string,Json>>;
/** Static owned catalog, fresh synchronous snapshots. Query projection follows
 * klippy/webhooks.py: missing objects are {}, explicitly missing fields null. */
export class NativeObjects {
 #readers:ReadonlyMap<string,NativeObjectReader>;#clock:()=>number;#last=-Infinity;
 constructor(readers:ReadonlyMap<string,NativeObjectReader>,clock:()=>number){
  if(!readers.size||readers.size>4096||typeof clock!=='function')throw new TypeError('Invalid native object catalog');
  for(const [name,read] of readers){new SubscriptionFilter({[name]:null});if(typeof read!=='function')throw new TypeError('Invalid native object reader');}
  this.#readers=new Map(readers);this.#clock=clock;
 }
 list(){return {objects:[...this.#readers.keys()]};}
 query(objects:unknown){
  const filter=new SubscriptionFilter(objects);let fields=0;for(const names of Object.values(filter.objects))if(names){fields+=names.length;if(fields>16384)throw new ApiError(429,'Native object query field capacity exceeded');}
  let eventtime:number;try{eventtime=this.#clock();if(!Number.isFinite(eventtime)||eventtime<0||eventtime<this.#last)throw new Error();}catch{throw new ApiError(503,'Native object clock is unavailable');}this.#last=eventtime;
  const entries:[string,Record<string,Json>][]=[];let remaining=1024*1024-128;
  for(const [name,requested] of Object.entries(filter.objects)){
   const reader=this.#readers.get(name);let source:Readonly<Record<string,Json>>={};
   if(reader)try{const value=reader(eventtime);if(value&&typeof (value as any).then==='function'){void Promise.resolve(value).catch(()=>{});throw new Error();}if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error();source=value;}catch{throw new ApiError(503,'Native object status is unavailable');}
   try{
   const names=requested??Object.keys(source);if(names.some(field=>!field||field.length>256||field.includes('\0')))throw new ApiError(503,'Invalid native object field');
   const selected:Record<string,Json>={};for(const field of names)put(selected,field,Object.hasOwn(source,field)?source[field]:null);
   try{validateJson(selected);}catch(error){if(error instanceof Error&&error.message==='JSON structure limit')throw new ApiError(413,'Native object structure capacity exceeded');throw new ApiError(503,'Native object status is unavailable');}
   remaining-=boundedJsonBytes({[name]:selected},remaining);entries.push([name,copy(selected) as Record<string,Json>]);
   }catch(error){if(error instanceof ApiError&&error.status===413)throw error;throw new ApiError(503,'Native object status is unavailable');}
  }
  return {eventtime,status:Object.fromEntries(entries)};
 }
}
export function registerNativeObjects(registry:EndpointRegistry,objects:NativeObjects):()=>void{
 const releases:(()=>void)[]=[];try{
  releases.push(registry.register({endpoint:'objects/list',methods:['GET','POST'],remote:true},()=>objects.list()));
  releases.push(registry.register({endpoint:'objects/query',methods:['GET','POST'],remote:true},params=>objects.query(params.objects)));
 }catch(error){for(const release of releases.reverse())release();throw error;}
 return ()=>{for(const release of releases.splice(0).reverse())release();};
}
