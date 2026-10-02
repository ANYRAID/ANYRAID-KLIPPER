import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import {applyZEndstopOffset} from '../homing/z-endstop.ts';
/** Persist the active coordinate offset against the loaded endstop, once per
 * generation. A revision protects against changes away and back to the same Z. */
export function registerNativeZOffset(registry:EndpointRegistry,gate:MaintenanceGate,port:{offset():{value:number;revision:string};idle():boolean},configured:number,minimum:number,maximum:number,session?:KlipperSaveSession){
 applyZEndstopOffset(configured,0,minimum,maximum);
 let token=randomUUID(),revision='',closed=false,state:'ready'|'saving'|'saved'|'failed'='ready',pending:Promise<Json>|undefined,receipt:{token:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{
  const offset=port.offset();if(!Number.isFinite(offset.value)||!/^\d+$/.test(offset.revision))throw new Error('Invalid live Z offset');
  if(offset.revision!==revision){revision=offset.revision;token=randomUUID();}
  let proposed:number|null=null;try{proposed=applyZEndstopOffset(configured,offset.value,minimum,maximum);}catch{}
  return {state_token:token,state,configured_position_endstop:configured,z_offset:offset.value,position_endstop:proposed,persisted:state==='saved',restart_required:state==='saved'||state==='failed',available:!!session&&!closed&&state==='ready'&&offset.value!==0&&proposed!==null&&gate.available&&port.idle()};
 };
 const unregister=registry.register({endpoint:'/printer/configuration/z_offset',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  if(closed)throw new ApiError(503,'Z offset owner closed');
  if(receipt?.token===params.state_token)return structuredClone(receipt.value);
  const current=snapshot();if(params.state_token!==token)throw new ApiError(409,'Stale Z offset');
  if(!current.available||!session||current.position_endstop===null)throw new ApiError(409,'Z offset save requires a nonzero valid offset, idle printer and persistence');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks Z offset save');}
  const consumed=token,value=current.position_endstop,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply([{kind:'set',section:'stepper_z',option:'position_endstop',value:String(value)}]);
   const saved=await session.save(signal);if(!saved||saved.pending)throw new Error('Z offset save did not settle');session.sealForRestart();state='saved';const result=snapshot();receipt={token:consumed,value:structuredClone(result)};return result;
  }catch{state='failed';throw new ApiError(503,'Z offset save failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Z offset owner closed'));unregister();await pending?.catch(()=>{});};
}
