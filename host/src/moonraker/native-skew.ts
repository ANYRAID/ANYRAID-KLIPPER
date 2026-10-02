import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {measuredSkew,type SkewFactors} from '../motion/skew.ts';
export function registerNativeSkew(registry:EndpointRegistry,gate:MaintenanceGate,profiles:Readonly<Record<string,Readonly<SkewFactors>>>,port:{snapshot():{revision:string;factors:SkewFactors};idle():boolean;set(factors:SkewFactors|undefined,signal:AbortSignal):Promise<void>;fail(error:unknown):Promise<void>}){
 let token=randomUUID(),revision='',closed=false,pending:Promise<Json>|undefined,receipt:{token:string;request:string;revision:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{const state=port.snapshot();if(state.revision!==revision){revision=state.revision;token=randomUUID();}return {state_token:token,factors:{...state.factors},profiles:Object.keys(profiles),available:!closed&&!pending&&gate.available&&port.idle(),persisted:false};};
 const remove=registry.register({endpoint:'/printer/settings/skew',methods:['GET','POST']},async(params,verb,context)=>{
  context.signal.throwIfAborted();if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Expected no query parameters');return snapshot();}
  if(Object.keys(params).some(k=>!['version','state_token','action','profile','measurements'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  let factors:SkewFactors|undefined;
  if(params.action==='clear'){if(params.profile!==undefined||params.measurements!==undefined)throw new ApiError(400,'Clear accepts no profile or measurements');}
  else if(params.action==='load'){
   if(typeof params.profile!=='string'||!Object.hasOwn(profiles,params.profile)||params.measurements!==undefined)throw new ApiError(400,'Unknown skew profile');factors={...profiles[params.profile]};
  }else if(params.action==='measure'){
   const values=params.measurements;if(params.profile!==undefined||!values||typeof values!=='object'||Array.isArray(values)||Object.keys(values).length!==3||Object.keys(values).some(k=>!['xy','xz','yz'].includes(k)))throw new ApiError(400,'Expected measurements for all three planes');
   const computed={} as SkewFactors;
   for(const plane of ['xy','xz','yz'] as const){const lengths=(values as Record<string,unknown>)[plane];if(lengths===null){computed[plane]=0;continue;}if(!Array.isArray(lengths)||lengths.length!==3||!lengths.every(v=>typeof v==='number'&&Number.isFinite(v)))throw new ApiError(400,'Expected AC, BD, AD lengths or null');try{computed[plane]=measuredSkew(lengths[0],lengths[1],lengths[2]);}catch{throw new ApiError(400,'Invalid skew measurement geometry');}}
   factors=computed;
  }else throw new ApiError(400,'Unknown skew action');
  const state=snapshot(),request=JSON.stringify([params.action,params.profile??null,factors??null]);
  if(closed)throw new ApiError(503,'Skew settings closed');
  if(receipt?.token===params.state_token&&receipt.revision===revision){if(receipt.request!==request)throw new ApiError(409,'Skew retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale skew state token');
  if(!state.available)throw new ApiError(409,'Skew settings require an idle printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks skew settings');}
  const consumed=token,signal=AbortSignal.any([context.signal,lifetime.signal]);
  pending=(async()=>{try{await port.set(factors,signal);signal.throwIfAborted();token=randomUUID();const value={...snapshot(),available:false};receipt={token:consumed,request,revision,value:structuredClone(value)};return value;}
   catch(error){gate.invalidate();await port.fail(error).catch(()=>{});throw new ApiError(503,'Skew settings failed; reinitialize printer');}
   finally{release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Skew settings closed'));remove();await pending?.catch(()=>{});};
}
