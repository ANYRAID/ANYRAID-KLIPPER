import {deltaObjectDistances} from '../calibration/delta-measurements.ts';
import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {KlipperSaveSession} from '../config/klipper-save-session.ts';
import {deltaCalibrationSaveChanges} from '../config/delta-calibration-state.ts';
import {DeltaCalibrationExecutor} from '../calibration/delta-calibration-executor.ts';
import type {DeltaCalibrationInput,fitDeltaCalibration} from '../calibration/delta-calibration.ts';

/** Generation-owned measured candidate. Clients never submit geometry or G-code. */
export function registerNativeDeltaCalibration(registry:EndpointRegistry,gate:MaintenanceGate,motion:{canProbe?:boolean;idle():boolean;measure(signal:AbortSignal):Promise<DeltaCalibrationInput>;synchronize():void;restored?():DeltaCalibrationInput;captureStable?(signal:AbortSignal):Promise<readonly [number,number,number]>;validateGeometry?(geometry:ReturnType<typeof fitDeltaCalibration>['geometry']):void},session?:KlipperSaveSession){
 let token=randomUUID(),state:'ready'|'measuring'|'candidate'|'saving'|'saved'|'failed'='ready',closed=false;
 let candidate:{input:DeltaCalibrationInput;result:ReturnType<typeof fitDeltaCalibration>}|undefined;
 let observations:DeltaCalibrationInput|undefined;
 let pending:Promise<Json>|undefined,receipt:{token:string;key:string;value:Json}|undefined;
 const lifetime=new AbortController(),executor=new DeltaCalibrationExecutor();
 const snapshot=():Json=>({manual_count:(observations??candidate?.input??motion.restored?.())?.manual?.length??0,automatic:motion.canProbe!==false,state_token:token,state,available:!closed&&['ready','candidate'].includes(state)&&gate.available&&motion.idle(),can_save:!!session&&state==='candidate',restart_required:state==='saved'||state==='failed',candidate:candidate?{geometry:{...candidate.result.geometry,angles:[...candidate.result.geometry.angles],arms:[...candidate.result.geometry.arms],endstops:[...candidate.result.geometry.endstops],stepDistances:[...candidate.result.geometry.stepDistances]},initial_error:candidate.result.initialError,final_error:candidate.result.finalError,height_residuals:[...candidate.result.heightResiduals],distance_residuals:[...candidate.result.distanceResiduals]}:null});
 const unregister=registry.register({endpoint:'/printer/calibration/delta',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','action','measurements','height'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.action!=='string'||!['calibrate','extend','height','save'].includes(params.action))throw new ApiError(400,'Expected version, state_token and calibrate/extend/height/save action');
  if(params.action!=='extend'&&params.measurements!==undefined)throw new ApiError(400,'Measurements require extend action');
  if(params.action==='height'?(typeof params.height!=='number'||!Number.isFinite(params.height)):params.height!==undefined)throw new ApiError(400,'Height action requires a finite measured height');
  const key=JSON.stringify([params.action,params.measurements??null,params.height??null]);
  if(closed)throw new ApiError(503,'Delta calibration owner closed');
  if(receipt?.token===params.state_token){if(receipt.key!==key)throw new ApiError(409,'Delta retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale Delta calibration token');
  if(!['ready','candidate'].includes(state)||!motion.idle())throw new ApiError(409,'Delta calibration requires an idle homed printer');
  if(params.action==='save'&&(!session||!candidate))throw new ApiError(409,'No measured Delta candidate or persistence');
  if(params.action==='calibrate'&&motion.canProbe===false)throw new ApiError(409,'Use manual Delta calibration without a probe');
  const heightBase=params.action==='height'?candidate?.input??observations??motion.restored?.():undefined;
  if(params.action==='height'&&(!heightBase||!motion.captureStable||(heightBase.manual?.length??0)>=999))throw new ApiError(409,'Manual height capture unavailable or full');
  let extended:DeltaCalibrationInput|undefined;
  if(params.action==='extend'){
   const base=candidate?.input??observations??motion.restored?.();if(!base?.probes.length)throw new ApiError(409,'Run and save basic Delta calibration first');
   try{extended={...structuredClone(base),distances:deltaObjectDistances(params.measurements,base.geometry)};}catch{throw new ApiError(400,'Invalid Delta object measurements');}
  }
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks Delta calibration');}
  const consumed=token,action=params.action as string,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Delta calibration deadline exceeded')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  state=action==='save'?'saving':'measuring';
  pending=(async()=>{try{
   signal.throwIfAborted();
   if(action==='height'){
    const stable=await motion.captureStable!(signal);signal.throwIfAborted();if(stable.length!==3||!stable.every(Number.isFinite))throw new Error('Invalid captured Delta position');
    observations={...structuredClone(heightBase!),manual:[...heightBase!.manual??[],{height:params.height as number,stable:[...stable]}]};candidate=undefined;state='ready';
   }else if(action==='calibrate'||action==='extend'){
    candidate=undefined;const input=extended??structuredClone(await motion.measure(signal));signal.throwIfAborted();if(!extended){input.manual=structuredClone(observations?.manual??input.manual??[]);motion.synchronize();}
    const result=await executor.fit(input,{signal});signal.throwIfAborted();motion.validateGeometry?.(result.geometry);observations=input;candidate={input,result};state='candidate';
   }else{
    session!.apply(deltaCalibrationSaveChanges(candidate!.input,candidate!.result));
    const saved=await session!.save(signal);if(!saved||saved.pending)throw new Error('Delta save did not settle');
    session!.sealForRestart();state='saved';gate.invalidate();
   }
   token=randomUUID();release();const value=snapshot();receipt={token:consumed,key,value:structuredClone(value)};return value;
  }catch{candidate=undefined;state='failed';gate.invalidate();throw new ApiError(503,'Delta calibration failed; reinitialize and inspect configuration');}
  finally{clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 const close=async()=>{closed=true;lifetime.abort(new Error('Delta calibration owner closed'));unregister();await pending?.catch(()=>{});};
 return Object.assign(close,{async acceptManual(input:DeltaCalibrationInput,signal:AbortSignal):Promise<Json>{
  if(closed||pending||!['ready','candidate'].includes(state)||!gate.status.maintenance||gate.status.closed)throw new Error('Delta manual result has no active maintenance owner');
  state='measuring';candidate=undefined;const owned=structuredClone({...input,manual:observations?.manual??input.manual}),combined=AbortSignal.any([signal,lifetime.signal]);
  pending=(async()=>{try{const result=await executor.fit(owned,{signal:combined});combined.throwIfAborted();motion.validateGeometry?.(result.geometry);observations=owned;candidate={input:owned,result};state='candidate';token=randomUUID();receipt=undefined;return snapshot();}catch(error){state='failed';gate.invalidate();throw error;}})();
  try{return await pending;}finally{pending=undefined;}
 }});
}
