import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import type {SkewFactors} from '../motion/skew.ts';
/** Persist the current server-owned coefficients, not client-supplied values. */
export function registerNativeSkewSave(registry:EndpointRegistry,gate:MaintenanceGate,port:{snapshot():{revision:string;factors:SkewFactors};idle():boolean},session?:KlipperSaveSession){
 let token=randomUUID(),revision='',state:'ready'|'saving'|'saved'|'failed'='ready',closed=false,pending:Promise<Json>|undefined,receipt:{token:string;request:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{const skew=port.snapshot();if(skew.revision!==revision){revision=skew.revision;token=randomUUID();}return {state_token:token,state,factors:{...skew.factors},restart_required:state==='saved'||state==='failed',available:!!session&&!closed&&state==='ready'&&gate.available&&port.idle()};};
 const remove=registry.register({endpoint:'/printer/configuration/skew',methods:['GET','POST']},async(params,verb,context)=>{
  context.signal.throwIfAborted();if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Expected no query parameters');return snapshot();}
  if(Object.keys(params).some(k=>!['version','state_token','action','profile'].includes(k))||params.version!==1||typeof params.state_token!=='string'||!['save','remove'].includes(params.action as string)||typeof params.profile!=='string'||!params.profile.length||params.profile!==params.profile.trim()||params.profile.length>128||/[\x00-\x1f\x7f\[\]]/.test(params.profile))throw new ApiError(400,'Expected version, state_token, action and profile name');
  if(closed)throw new ApiError(503,'Skew persistence closed');const request=JSON.stringify([params.action,params.profile]);
  if(receipt?.token===params.state_token){if(receipt.request!==request)throw new ApiError(409,'Skew persistence retry conflicts');return structuredClone(receipt.value);}
  const current=snapshot();if(params.state_token!==token)throw new ApiError(409,'Stale skew state token');
  if(!current.available||!session)throw new ApiError(409,'Skew persistence requires idle printer and configuration session');
  const section='skew_correction '+params.profile;
  if(params.action==='remove'&&!session.hasSavedSection(section))throw new ApiError(400,'Only autosaved skew profiles can be removed');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks skew persistence');}
  const consumed=token,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply(params.action==='remove'?[{kind:'remove',section}]:(['xy','xz','yz'] as const).map(axis=>({kind:'set' as const,section,option:axis+'_skew',value:String(current.factors[axis])})));
   const saved=await session.save(signal,params.action==='remove'?{allowEmpty:true,absentSections:[section]}:{});if(!saved||saved.pending)throw new Error('Skew save did not settle');session.sealForRestart();state='saved';
   const value={...snapshot(),profile:params.profile,action:params.action};receipt={token:consumed,request,value:structuredClone(value)};return value;
  }catch{state='failed';throw new ApiError(503,'Skew persistence failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Skew persistence closed'));remove();await pending?.catch(()=>{});};
}
