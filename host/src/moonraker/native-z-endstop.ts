import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import {registerManualBedTilt,type ManualBedTiltMotion} from './native-manual-bed-tilt.ts';
import {calibrateZEndstop} from '../homing/z-endstop.ts';
/** Measurement and persistence are separate typed actions. The client cannot
 * supply an endstop value; only this generation's accepted contact can be saved. */
export function registerNativeZEndstop(registry:EndpointRegistry,gate:MaintenanceGate,motion:Omit<ManualBedTiltMotion,'apply'>,positionEndstop:number,session?:KlipperSaveSession){
 const minimum=motion.limits.axisMinimum[2],maximum=motion.limits.axisMaximum[2];
 if(!Number.isFinite(positionEndstop)||!Number.isFinite(minimum)||!Number.isFinite(maximum)||minimum>=maximum||positionEndstop<minimum||positionEndstop>maximum)throw new RangeError('Invalid configured Z endstop');
 let candidate:{position_endstop:number;contact:number[]}|null=null,token=randomUUID(),state:'ready'|'saving'|'saved'|'failed'='ready',closed=false,pending:Promise<Json>|undefined,receipt:{token:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const closeProbe=registerManualBedTilt(registry,gate,{...motion,apply:async(samples,signal)=>{
  signal.throwIfAborted();candidate={position_endstop:calibrateZEndstop(positionEndstop,samples[0][2],minimum,maximum),contact:[...samples[0]]};token=randomUUID();receipt=undefined;
  return {...candidate,persisted:false};
 }},{points:[[0,0]],horizontalHeight:0,travelSpeed:5},300000,'z_endstop');
 const snapshot=()=>({state_token:token,state,configured_position_endstop:positionEndstop,candidate:candidate?structuredClone(candidate):null,persisted:state==='saved',restart_required:state==='saved'||state==='failed',available:!!session&&!!candidate&&!closed&&state==='ready'&&gate.available&&motion.idle()});
 const unregister=registry.register({endpoint:'/printer/configuration/z_endstop',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  if(closed)throw new ApiError(503,'Z endstop owner closed');
  if(receipt?.token===params.state_token)return structuredClone(receipt.value);
  if(params.state_token!==token)throw new ApiError(409,'Stale Z endstop calibration');
  if(!snapshot().available||!session||!candidate)throw new ApiError(409,'Z endstop save requires an idle calibrated printer and persistence');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks Z endstop save');}
  const consumed=token,value=candidate.position_endstop,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply([{kind:'set',section:'stepper_z',option:'position_endstop',value:String(value)}]);
   const saved=await session.save(signal);if(!saved||saved.pending)throw new Error('Z endstop save did not settle');session.sealForRestart();state='saved';const result=snapshot();receipt={token:consumed,value:structuredClone(result)};return result;
  }catch{state='failed';throw new ApiError(503,'Z endstop save failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Z endstop owner closed'));unregister();await Promise.all([closeProbe(),pending?.catch(()=>{})]);};
}
