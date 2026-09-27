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
 let receipt:{token:string;stepper:string;value:Json}|undefined;const lifetime=new AbortController();
 const snapshot=()=>{
  const data=port.snapshot();if(data.revision!==revision){revision=data.revision;token=randomUUID();}
  return {state_token:token,state,steppers:data.steppers,persisted:state==='saved',restart_required:state==='saved'||state==='failed',available:!!session&&!closed&&state==='ready'&&gate.available&&port.idle()};
 };
 const unregister=registry.register({endpoint:'/printer/calibration/endstop_phase',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','stepper','action'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.stepper!=='string'||params.action!=='save')throw new ApiError(400,'Expected version, state_token, stepper and save action');
  if(closed)throw new ApiError(503,'Endstop phase owner closed');
  const current=snapshot();
  if(state==='saved'&&receipt?.token===params.state_token){if(receipt.stepper!==params.stepper)throw new ApiError(409,'Phase save retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale endstop phase observations');
  if(!session)throw new ApiError(409,'Configuration persistence is unavailable');
  if(!current.available)throw new ApiError(409,'Phase save requires an idle available printer');
  const row=current.steppers.find(s=>s.name===params.stepper);if(!row||!row.primary)throw new ApiError(400,'Unknown or non-primary homing stepper');
  if(!row.calibration)throw new ApiError(409,'Home the axis before saving phase calibration');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks phase save');}
  const consumed=token,stepper=row.name,calibration=row.calibration,signal=AbortSignal.any([context.signal,lifetime.signal]);state='saving';
  pending=(async()=>{try{
   signal.throwIfAborted();session.apply([{kind:'set',section:'endstop_phase '+stepper,option:'trigger_phase',value:calibration.phase+'/'+calibration.phases}]);
   const saved=await session.save(signal);if(!saved||saved.pending)throw new Error('Phase save did not settle');
   session.sealForRestart();state='saved';const value={...snapshot(),stepper,saved_phase:calibration.phase+'/'+calibration.phases};receipt={token:consumed,stepper,value:structuredClone(value)};return value;
  }catch{state='failed';throw new ApiError(503,'Endstop phase save failed; reinitialize and inspect configuration');}
  finally{gate.invalidate();release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Endstop phase owner closed'));unregister();await pending?.catch(()=>{});};
}
