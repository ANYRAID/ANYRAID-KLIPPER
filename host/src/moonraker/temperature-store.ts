// Moonraker data_store.py temperature history. GPL-3.0-or-later.
// Original Copyright (C) 2020 Eric Callahan.
import {roundMetadataDecimal} from './metadata-values.ts';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {StatusView} from './subscription-status.ts';
const fields=new Set(['temperature','target','power','speed']);
type Value=number|null;
function value(raw:unknown):Value{if(raw===null)return null;if(typeof raw!=='number'||!Number.isFinite(raw))throw new ApiError(502,'Invalid temperature history value');return raw;}
/** toFixed rounds the exact binary value, but sends exact decimal ties away
 * from zero. At two places a binary-representable tie must be an odd eighth:
 * (2k+1)/200 is binary iff its numerator is divisible by 25. Correct only
 * those ties to even. This range keeps all integer products below 2^53. */
function rounded(raw:number):number{
 if(raw===0)return raw;
 const absolute=Math.abs(raw);if(absolute>=1e13)return roundMetadataDecimal(raw,2);
 const eighths=absolute*8;
 if(Number.isInteger(eighths)&&eighths%2===1){const lower=(eighths*25-1)/2;return Math.sign(raw)*(lower+(lower%2))/100;}
 return Number(raw.toFixed(2));
}
class History {
 readonly values:Value[];head=0;length=0;raw:Value|undefined;rounded:Value=null;
 constructor(capacity:number){this.values=new Array(capacity);}
 append(raw:Value){if(!Object.is(raw,this.raw)){this.rounded=raw===null?null:rounded(raw);this.raw=raw;}this.values[(this.head+this.length)%this.values.length]=this.rounded;if(this.length<this.values.length)this.length++;else this.head=(this.head+1)%this.values.length;}
 snapshot():Value[]{return Array.from({length:this.length},(_,i)=>this.values[(this.head+i)%this.values.length]);}
}
export interface TemperatureStoreLimits {capacity?:number;maxSensors?:number;maxSlots?:number;}
/** Telemetry only: rounded history is never fed back to motion or heater control. */
export class TemperatureStore {
 readonly #capacity:number;readonly #maxSensors:number;readonly #maxSlots:number;
 #sensors=new Map<string,Map<string,History>>();#monitors=new Set<string>();
 constructor({capacity=1200,maxSensors=128,maxSlots=1000000}:TemperatureStoreLimits={}){for(const [n,max] of [[capacity,100000],[maxSensors,4096],[maxSlots,16000000]])if(!Number.isSafeInteger(n)||n<1||n>max)throw new RangeError('Invalid temperature history limits');this.#capacity=capacity;this.#maxSensors=maxSensors;this.#maxSlots=maxSlots;}
 get status(){return {sensors:this.#sensors.size,fields:[...this.#sensors.values()].reduce((n,s)=>n+s.size,0),capacity:this.#capacity};}
 configure(sensors:readonly string[],monitors:readonly string[],status:StatusView):void{
  const names=[...new Set([...sensors,...monitors])];if(names.length>this.#maxSensors)throw new ApiError(429,'Too many temperature sensors');
  const plan=names.map(name=>{if(typeof name!=='string'||!name||name.length>256||name.includes('\0'))throw new ApiError(502,'Invalid temperature sensor name');return {name,values:Object.entries(Object.hasOwn(status,name)?status[name]:{}).filter(([field])=>fields.has(field)).map(([field,raw])=>[field,value(raw)] as const)};});
  if(plan.reduce((n,s)=>n+s.values.length,0)*this.#capacity>this.#maxSlots)throw new ApiError(429,'Temperature history capacity exceeded');
  const next=new Map<string,Map<string,History>>();
  for(const sensor of plan){if(!sensor.values.length)continue;next.set(sensor.name,new Map(sensor.values.map(([field])=>[field,this.#sensors.get(sensor.name)?.get(field)??new History(this.#capacity)])));}
  for(const sensor of plan)for(const [field,raw] of sensor.values)next.get(sensor.name)!.get(field)!.append(raw);
  this.#sensors=next;this.#monitors=new Set(monitors);
 }
 sample(status:StatusView):void{
  const pending:[History,Value][]=[];
  for(const [name,sensor] of this.#sensors){const data=Object.hasOwn(status,name)?status[name]:{};for(const [field,history] of sensor)pending.push([history,Object.hasOwn(data,field)?value(data[field]):history.rounded]);}
  for(const [history,raw] of pending)history.append(raw);
 }
 snapshot(includeMonitors=false):Record<string,Record<string,Value[]>>{return Object.fromEntries([...this.#sensors].filter(([name])=>includeMonitors||!this.#monitors.has(name)).map(([name,sensor])=>[name,Object.fromEntries([...sensor].map(([field,history])=>[field+'s',history.snapshot()]))]));}
}
export function includeTemperatureMonitors(value:Json|undefined):boolean{if(value===undefined)return false;if(typeof value==='boolean')return value;if(typeof value==='string'&&['true','false'].includes(value.toLowerCase()))return value.toLowerCase()==='true';throw new ApiError(400,'Unable to parse argument: include_monitors');}
export function registerTemperatureStore(registry:EndpointRegistry,store:TemperatureStore):()=>void{return registry.register({endpoint:'/server/temperature_store',methods:['GET']},params=>store.snapshot(includeTemperatureMonitors(params.include_monitors)));}
