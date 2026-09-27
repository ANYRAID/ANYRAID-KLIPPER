import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {initialBedScrewsState,planBedScrews,validateBedScrewsPlan,type BedScrewsPlan} from '../homing/bed-screws.ts';
import type {ManualBedTiltMotion} from './native-manual-bed-tilt.ts';
export function registerNativeBedScrews(registry:EndpointRegistry,gate:MaintenanceGate,motion:Omit<ManualBedTiltMotion,'apply'|'measured'>,options:BedScrewsPlan,idleTimeoutMs=300000){
 const plan=structuredClone(options);validateBedScrewsPlan(plan);if(!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<1||idleTimeoutMs>600000)throw new RangeError('Invalid bed screw timeout');
 let state=initialBedScrewsState(),phase:'ready'|'moving'|'awaiting'|'completed'|'failed'|'cancelled'='ready',token=randomUUID(),closed=false,release:(()=>void)|undefined,pending:Promise<Json>|undefined,stopping:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let abort=new AbortController(),expected:readonly number[]|undefined,last:{token:string;action:string;value:Json}|undefined;
 const snapshot=()=>({state_token:token,phase,is_active:!!release,state:state.phase==='idle'?null:state.phase,current_screw:state.current,accepted_screws:state.accepted,name:state.phase==='idle'?null:(state.phase==='adjust'?plan.coarse:plan.fine)[state.current].name,available:!closed&&!release&&(phase==='ready'||phase==='completed')&&gate.available&&motion.idle()});
 const stop=(cause:unknown,cancelled=false):Promise<void>=>{
  if(stopping)return stopping;phase=cancelled?'cancelled':'failed';token=randomUUID();last=undefined;clearTimeout(timer);gate.invalidate();abort.abort(cause);
  stopping=Promise.resolve().then(()=>motion.stop(cause)).finally(()=>{release?.();release=undefined;state=initialBedScrewsState();});return stopping;
 };
 const unsubscribe=motion.subscribeStop(cause=>{if(release)void stop(cause).catch(()=>{});});
 const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>{void stop(new Error('Bed screw session expired')).catch(()=>{});},idleTimeoutMs);timer.unref();};
 const remove=registry.register({endpoint:'/printer/calibration/bed_screws',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(params.version!==1||typeof params.state_token!=='string'||!['start','accept','adjusted','cancel'].includes(params.action as string)||Object.keys(params).some(k=>!['version','state_token','action'].includes(k)))throw new ApiError(400,'Expected version, state_token and bed screw action');
  if(closed)throw new ApiError(503,'Bed screw owner closed');const action=params.action as 'start'|'accept'|'adjusted'|'cancel';
  if(last?.token===params.state_token){if(last.action!==action)throw new ApiError(409,'Bed screw retry conflicts');return structuredClone(last.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale bed screw token');
  if(action==='cancel'){if(!release)throw new ApiError(409,'No active bed screw session');const consumed=token;await stop(new Error('Bed screw session cancelled'),true);const value=snapshot();last={token:consumed,action,value};return value;}
  if(pending)throw new ApiError(409,'Bed screw movement pending');
  if(action==='start'){if(!snapshot().available)throw new ApiError(409,'Bed screws require idle homed printer');}
  else if(phase!=='awaiting')throw new ApiError(409,'Bed screws are not awaiting confirmation');
  const position=motion.planned();if(action!=='start'&&expected?.some((v,i)=>v!==position[i])){await stop(new Error('Bed screw position ownership changed'));throw new ApiError(503,'Reinitialize bed screw session');}
  const next=planBedScrews(plan,state,action,position);
  for(const move of next.moves)if(move.position.slice(0,3).some((v,i)=>v<motion.limits.axisMinimum[i]||v>motion.limits.axisMaximum[i]))throw new ApiError(400,'Bed screw target outside machine limits');
  if(action==='start'){try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks bed screws');}abort=new AbortController();stopping=undefined;}
  const consumed=token,signal=AbortSignal.any([context.signal,abort.signal]);phase='moving';arm();
  pending=(async()=>{try{
   for(const move of next.moves){signal.throwIfAborted();await motion.move(move.position,move.speed,signal);}signal.throwIfAborted();motion.synchronize();expected=[...motion.planned()];state=next.state;
   if(state.phase==='idle'){phase='completed';clearTimeout(timer);release?.();release=undefined;}else{phase='awaiting';arm();}
   token=randomUUID();const value=snapshot();last={token:consumed,action,value:structuredClone(value)};return value;
  }catch(error){await stop(error).catch(()=>{});throw new ApiError(503,'Bed screw motion failed; reinitialize');}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;remove();unsubscribe();clearTimeout(timer);if(release||pending)await stop(new Error('Bed screw owner closed')).catch(()=>{});await pending?.catch(()=>{});};
}
