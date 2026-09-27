import {randomUUID} from 'node:crypto';
import {ApiError} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {TemperatureFanControl} from '../thermal/temperature-fan.ts';
/** Settings are atomic; MCU output follows the next valid sensor sample.
 * One bounded retry receipt per fan; tokens fence reloads and external edits. */
export function registerNativeTemperatureFans(registry:EndpointRegistry,fans:readonly {section:string;control:TemperatureFanControl}[],available:()=>boolean):()=>void{
 let closed=false;
 const entries=new Map(fans.map(f=>{
  let token=randomUUID(),fingerprint=f.control.revision;
  const snapshot=()=>{const s=f.control.settings,next=f.control.revision;if(next!==fingerprint){fingerprint=next;token=randomUUID();}return {name:f.section,state_token:token,target:s.target,min_speed:s.minimumSpeed,max_speed:s.maximumSpeed,min_temp:s.minimumTemperature,max_temp:s.maximumTemperature,available:!closed&&available(),persisted:false,applies_to:'next_temperature_sample'};};
  let previous:{token:string;request:string;fingerprint:number;receipt:ReturnType<typeof snapshot>}|undefined;
  return [f.section,{snapshot,update(params:Record<string,unknown>){
   const state=snapshot();if(!state.available)throw new ApiError(409,'Temperature fan settings unavailable');
   const request=JSON.stringify([params.target??null,params.min_speed??null,params.max_speed??null]);
   if(previous&&previous.token===params.state_token&&previous.fingerprint===fingerprint){if(previous.request!==request)throw new ApiError(409,'Temperature fan retry conflicts');return {...previous.receipt};}
   if(params.state_token!==token)throw new ApiError(409,'Stale temperature fan state token');
   const update={...(params.target===undefined?{}:{target:params.target as number}),...(params.min_speed===undefined?{}:{minimumSpeed:params.min_speed as number}),...(params.max_speed===undefined?{}:{maximumSpeed:params.max_speed as number})};
   try{f.control.configure(update);}catch{throw new ApiError(400,'Invalid temperature fan target or speed range');}
   const consumed=token;token=randomUUID();const receipt=snapshot();previous={token:consumed,request,fingerprint,receipt};return {...receipt};
  }}] as const;
 }));
 if(entries.size!==fans.length)throw new Error('Duplicate temperature fan setting owner');
 const remove=registry.register({endpoint:'/printer/settings/temperature_fan',methods:['GET','POST']},(params,verb,context)=>{
  context.signal.throwIfAborted();
  if(verb==='GET'){
   if(Object.keys(params).some(k=>k!=='name'))throw new ApiError(400,'Expected optional fan name');
   if(params.name===undefined)return {fans:[...entries.values()].map(e=>e.snapshot())};
  }else if(Object.keys(params).some(k=>!['name','version','state_token','target','min_speed','max_speed'].includes(k))||params.version!==1||typeof params.state_token!=='string'||!['target','min_speed','max_speed'].some(k=>params[k]!==undefined)||['target','min_speed','max_speed'].some(k=>params[k]!==undefined&&(typeof params[k]!=='number'||!Number.isFinite(params[k]))))throw new ApiError(400,'Expected version, state_token and finite temperature fan settings');
  if(typeof params.name!=='string'||!entries.has(params.name))throw new ApiError(400,'Unknown temperature fan');
  const entry=entries.get(params.name)!;return verb==='GET'?entry.snapshot():entry.update(params);
 });
 return ()=>{closed=true;remove();};
}
