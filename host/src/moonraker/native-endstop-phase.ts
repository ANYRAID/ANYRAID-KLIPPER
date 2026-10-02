import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
export interface EndstopPhaseMaintenance {snapshot():ReturnType<NativeLinearHomingPort['endstopPhaseCalibration']>;idle():boolean;}
/** Preview observed phase statistics; save only the server-selected circular
 * median, fenced by the observation revision and the loaded configuration. */
export function registerNativeEndstopPhase(registry:EndpointRegistry,gate:MaintenanceGate,port:EndstopPhaseMaintenance,session?:KlipperSaveSession){
 let token=randomUUID(),revision='',closed=false,state:'ready'|'saving'|'saved'|'failed'='ready',pending:Promise<Json>|undefined;
 let receipt:{token:string;key:string;value:Json}|undefined;const lifetime=new AbortController();
 const snapshot=()=>{
  const data=port.snapshot();if(data.revision!==revision){revision=data.revision;token=randomUUID();}
  return {state_token:token,state,steppers:data.steppers,persisted:state==='saved',restart_required:state==='saved'||state==='failed',available:!!session&&!closed&&state==='ready'&&gate.available&&port.idle()};
 };
 const unregister=registry.register({endpoint:'/printer/calibration/endstop_phase',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','stepper','steppers','action'].includes(k))||params.version!==1||typeof params.state_token!=='string'||params.action!=='save')throw new ApiError(400,'Expected version, state_token, stepper and save action');
  const single=Object.hasOwn(params,'stepper'),plural=Object.hasOwn(params,'steppers');
  if(single===plural||single&&typeof params.stepper!=='string'||plural&&!Array.isArray(params.steppers))throw new ApiError(400,'Specify stepper or steppers');
  const names=(single?[params.stepper]:params.steppers) as string[];
  if(!names.length||names.length>3||names.some(n=>typeof n!=='string')||new Set(names).size!==names.length)throw new ApiError(400,'Invalid homing stepper selection');
  const selected=[...names].sort(),key=JSON.stringify(selected);
  if(closed)throw new ApiError(503,'Endstop phase owner closed');
  const current=snapshot();
  if(state==='saved'&&receipt?.token===params.state_token){if(receipt.key!==key)throw new ApiError(409,'Phase save retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale endstop phase observations');
  if(!session)throw new ApiError(409,'Configuration persistence is unavailable');
  if(!current.available)throw new ApiError(409,'Phase save requires an idle available printer');
  const savedPhases=selected.map(name=>{
   const row=current.steppers.find(s=>s.name===name);if(!row||!row.primary)throw new ApiError(400,'Unknown or non-primary homing stepper');
   if(!row.calibration)throw new ApiError(409,'Home every selected axis before saving phase calibration');
   return {stepper:name,trigger_phase:row.calibration.phase+'/'+row.calibration.phases};
  });
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks phase save');}
  const consumed=token,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply(savedPhases.map(p=>({kind:'set',section:'endstop_phase '+p.stepper,option:'trigger_phase',value:p.trigger_phase})));
   const saved=await session.save(signal);if(!saved||saved.pending)throw new Error('Phase save did not settle');
   session.sealForRestart();state='saved';const value={...snapshot(),saved_phases:savedPhases,...savedPhases.length===1?{stepper:savedPhases[0].stepper,saved_phase:savedPhases[0].trigger_phase}:{}};receipt={token:consumed,key,value:structuredClone(value)};return value;
  }catch{state='failed';throw new ApiError(503,'Endstop phase save failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Endstop phase owner closed'));unregister();await pending?.catch(()=>{});};
}
