import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
/** Save only the server's measured plane, never client-supplied coefficients. */
export function registerNativeBedTiltSave(registry:EndpointRegistry,gate:MaintenanceGate,port:{snapshot():NativeLinearHomingPort['bedTiltStatus'];idle():boolean},session?:KlipperSaveSession){
 let token=randomUUID(),revision='',state:'ready'|'saving'|'saved'|'failed'='ready',closed=false,pending:Promise<Json>|undefined,receipt:{token:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{const tilt=port.snapshot();if(tilt?.revision!==revision){revision=tilt?.revision??'';token=randomUUID();}return {state_token:token,state,tilt:tilt??null,restart_required:state==='saved'||state==='failed',available:!!session&&!!tilt?.calibrated&&!closed&&state==='ready'&&gate.available&&port.idle()};};
 const unregister=registry.register({endpoint:'/printer/configuration/bed_tilt',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  if(closed)throw new ApiError(503,'Bed tilt owner closed');
  if(receipt?.token===params.state_token)return structuredClone(receipt.value);
  const current=snapshot();if(params.state_token!==token)throw new ApiError(409,'Stale bed tilt calibration');
  if(!current.available||!session||!current.tilt)throw new ApiError(409,'Bed tilt save requires idle calibrated printer and persistence');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks bed tilt save');}
  const consumed=token,tilt=current.tilt,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply((['x','y','z'] as const).map(axis=>({kind:'set',section:'bed_tilt',option:axis+'_adjust',value:String(tilt[axis])})));
   const saved=await session.save(signal);if(!saved||saved.pending)throw new Error('Bed tilt save did not settle');session.sealForRestart();state='saved';
   const value=snapshot();receipt={token:consumed,value:structuredClone(value)};return value;
  }catch{state='failed';throw new ApiError(503,'Bed tilt save failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Bed tilt save owner closed'));unregister();await pending?.catch(()=>{});};
}
