import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
/** Typed homing/probe/grid maintenance; no client script or motion target.
 * The product supplies configured geometry and the native operation owner. */
export function registerNativeProbe(registry:EndpointRegistry,gate:MaintenanceGate,motion:{idle():boolean;measure(signal:AbortSignal,axes?:readonly (0|1|2)[]):Promise<Json>;synchronize():void},kind:'probe'|'bed_mesh'|'bed_tilt'|'z_tilt'|'quad_gantry_level'|'home'='probe'){
 let token=randomUUID(),state:'ready'|'measuring'|'failed'='ready',closed=false;
 let last:{token:string;receipt:Json;axes:string}|undefined,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>({state_token:token,state,available:!closed&&state==='ready'&&gate.available&&motion.idle()});
 const releases=[registry.register({endpoint:'/printer/calibration/'+kind,methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token',...(kind==='home'?['axes']:[])].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  let axes:(0|1|2)[]|undefined;
  if(kind==='home'){const requested=params.axes??[0,1,2];if(!Array.isArray(requested)||!requested.length||requested.length>3||requested.some(axis=>axis!==0&&axis!==1&&axis!==2)||new Set(requested).size!==requested.length)throw new ApiError(400,'Expected unique home axes 0, 1 or 2');axes=(requested as (0|1|2)[]).slice().sort();}
  const axesKey=axes?.join(',')??'';
  if(closed)throw new ApiError(503,'Probe owner closed');
  if(last?.token===params.state_token){if(last.axes!==axesKey)throw new ApiError(409,'Consumed home token belongs to different axes');return structuredClone(last.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale probe state token');
  if(state!=='ready'||!motion.idle())throw new ApiError(409,kind==='home'?'Homing requires an idle printer':'Probe requires an idle homed printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks probe');}
  state='measuring';const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Probe deadline exceeded')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{
   signal.throwIfAborted();const result=await motion.measure(signal,axes);signal.throwIfAborted();motion.synchronize();
   token=randomUUID();state='ready';release();const receipt={...snapshot(),result};last={token:consumed,receipt:structuredClone(receipt),axes:axesKey};return receipt;
  }catch{state='failed';gate.invalidate();throw new ApiError(503,kind==='home'?'Homing failed; reinitialize before further motion':'Probe failed; reinitialize before further motion');}
  finally{clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 })];
 return async()=>{closed=true;lifetime.abort(new Error('Probe owner closed'));for(const release of releases)release();await pending?.catch(()=>{});};
}
