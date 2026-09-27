import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {BedTiltProbePlan} from '../config/bed-tilt.ts';
import {fitBedTilt} from '../motion/bed-tilt.ts';
import {manualProbeBounds,planManualProbe,type ManualProbeAdjustment} from '../homing/manual-probe.ts';
export interface ManualBedTiltMotion {
 idle():boolean;planned():readonly number[];measured():readonly number[];
 limits:{axisMinimum:readonly number[];axisMaximum:readonly number[]};
 move(position:readonly number[],speed:number,signal:AbortSignal):Promise<void>;
 apply(samples:readonly (readonly number[])[],signal:AbortSignal):Promise<Json>;
 synchronize():void;stop(cause:unknown):Promise<void>;subscribeStop(listener:(cause:unknown)=>void):()=>void;
}
/** Interactive lease remains held between requests. Reconnect reads state;
 * generation restart never resumes unverified physical work. */
export function registerManualBedTilt(registry:EndpointRegistry,gate:MaintenanceGate,motion:ManualBedTiltMotion,options:BedTiltProbePlan,idleTimeoutMs=300000,mode:'bed_tilt'|'probe'|'z_endstop'='bed_tilt'){
 const plan=structuredClone(options),limits=structuredClone(motion.limits);
 if(mode==='bed_tilt')fitBedTilt(plan.points.map(p=>[...p,0]));
 if(!Number.isSafeInteger(idleTimeoutMs)||idleTimeoutMs<1||idleTimeoutMs>600000||!Number.isFinite(plan.travelSpeed)||plan.travelSpeed<=0||!Number.isFinite(plan.horizontalHeight))throw new RangeError('Invalid manual calibration settings');
 let state:'ready'|'moving'|'awaiting'|'completed'|'cancelled'|'failed'='ready',token=randomUUID(),closed=false,release:(()=>void)|undefined,timer:ReturnType<typeof setTimeout>|undefined;
 let closing:Promise<void>|undefined;
 let lifetime=new AbortController(),pending:Promise<Json>|undefined,stopping:Promise<void>|undefined,last:{token:string;key:string;value:Json}|undefined;
 let samples:number[][]=[],position:number[]|null=null,expected:number[]|undefined,startZ=0,history:number[]=[],unchanged=false,result:Json=null;
 const clearTimer=()=>{clearTimeout(timer);timer=undefined;};
 const snapshot=()=>({state_token:token,state,point_index:samples.length,point_count:plan.points.length,point:mode!=='bed_tilt'&&position===null?null:[...plan.points[Math.min(samples.length,plan.points.length-1)]],position,lower:position?manualProbeBounds(position[2],history).lower:null,upper:position?manualProbeBounds(position[2],history).upper:null,unchanged,accepted:samples,result,available:!closed&&(state==='ready'||state==='completed')&&gate.available&&motion.idle()});
 const copy=():Json=>structuredClone(snapshot());
 function terminate(cause:unknown,cancelled=false):Promise<void>{
  if(stopping)return stopping;const done=Promise.withResolvers<void>();stopping=done.promise;
  state=cancelled?'cancelled':'failed';last=undefined;token=randomUUID();clearTimer();gate.invalidate();lifetime.abort(cause);
  void Promise.resolve().then(()=>motion.stop(cause)).then(()=>{release?.();release=undefined;done.resolve();},error=>{release?.();release=undefined;done.reject(error);});return stopping;
 }
 const arm=()=>{clearTimer();timer=setTimeout(()=>{void terminate(new Error('Manual calibration expired')).catch(()=>{});},idleTimeoutMs);timer.unref();};
 const unsubscribe=motion.subscribeStop(cause=>{if(release)void terminate(cause).catch(()=>{});});
 function validate(target:readonly number[]){if(target.length!==4||!target.every(Number.isFinite)||target.slice(0,3).some((v,i)=>v<limits.axisMinimum[i]||v>limits.axisMaximum[i]))throw new ApiError(400,'Manual calibration target outside machine limits');}
 function readPosition(){const p=[...motion.measured()];validate(p);position=p;expected=[...motion.planned()];motion.synchronize();}
 async function move(target:readonly number[],speed:number,signal:AbortSignal){validate(target);await motion.move(target,speed,signal);signal.throwIfAborted();}
 async function nextPoint(signal:AbortSignal){
  const current=[...motion.planned()],target=plan.points[samples.length];current[2]=Math.max(current[2],plan.horizontalHeight);await move(current,plan.travelSpeed,signal);
  current[0]=target[0];current[1]=target[1];await move(current,plan.travelSpeed,signal);current[2]=plan.horizontalHeight;await move(current,plan.travelSpeed,signal);
  readPosition();startZ=position![2];history=[];unchanged=false;state='awaiting';
 }
 const unregister=registry.register({endpoint:mode==='z_endstop'?'/printer/calibration/z_endstop':mode==='probe'?'/printer/calibration/manual_probe':'/printer/calibration/bed_tilt/manual',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return copy();
  const action=params.action,actions=['start','adjust','bisect_up','bisect_down','previous_up','previous_down','accept','cancel'];
  if(params.version!==1||typeof params.state_token!=='string'||typeof action!=='string'||!actions.includes(action)||Object.keys(params).some(k=>!['version','state_token','action',...(action==='adjust'?['delta']:[])].includes(k))||action==='adjust'&&typeof params.delta!=='number')throw new ApiError(400,'Expected version, state_token, action and optional numeric delta');
  if(closed)throw new ApiError(503,'Manual calibration owner closed');
  const key=JSON.stringify([action,params.delta??null]);
  if(last?.token===params.state_token){if(last.key!==key)throw new ApiError(409,'Manual calibration retry conflicts');return structuredClone(last.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale manual calibration state');
  if(action==='cancel'){
   if(!release)throw new ApiError(409,'No active manual calibration');const consumed=token;await terminate(new Error('Manual calibration cancelled'),true);const value=copy();last={token:consumed,key,value:structuredClone(value)};return value;
  }
  if(pending)throw new ApiError(409,'Manual calibration movement pending');
  if(action==='start'){
   if(!['ready','completed'].includes(state)||!gate.available||!motion.idle())throw new ApiError(409,'Manual calibration requires idle homed printer');
   const current=motion.planned();if(mode!=='bed_tilt'){validate(current);plan.points=[[current[0],current[1]]];plan.horizontalHeight=current[2];}for(const [x,y] of plan.points)validate([x,y,plan.horizontalHeight,current[3]]);
   try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks manual calibration');}
   lifetime=new AbortController();stopping=undefined;samples=[];result=null;position=null;history=[];
  }else if(state!=='awaiting'||!position)throw new ApiError(409,'Manual calibration is not awaiting input');
  let step:ReturnType<typeof planManualProbe>|undefined;
  if(action!=='start'&&action!=='accept'){
   try{step=planManualProbe(position![2],history,(action==='adjust'?params.delta:action) as ManualProbeAdjustment);const p=[...motion.planned()];p[2]=step.target;validate(p);p[2]=step.bob;validate(p);}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(400,'Invalid manual Z adjustment');}
  }
  if(action==='accept'&&position![2]>=startZ)throw new ApiError(409,'Lower the nozzle before accepting a contact point');
  const consumed=token,signal=AbortSignal.any([context.signal,lifetime.signal]);state='moving';arm();
  pending=(async()=>{try{
   signal.throwIfAborted();if(action!=='start'&&expected?.some((v,i)=>v!==motion.planned()[i]))throw new Error('Manual position ownership changed');
   if(action==='start'){if(mode!=='bed_tilt'){readPosition();startZ=position![2];history=[];unchanged=false;state='awaiting';}else await nextPoint(signal);}
   else if(step){
    const previous=position![2],p=[...motion.planned()];if(p[2]<step.bob){p[2]=step.bob;await move(p,Math.min(5,plan.travelSpeed),signal);}p[2]=step.target;await move(p,Math.min(5,plan.travelSpeed),signal);
    history=step.history;readPosition();unchanged=position![2]===previous;state='awaiting';
   }else{
    samples.push(position!.slice(0,3));
    if(samples.length<plan.points.length)await nextPoint(signal);
    else{if(mode==='bed_tilt'){const p=[...motion.planned()];p[2]=Math.max(p[2],plan.horizontalHeight);await move(p,plan.travelSpeed,signal);}result=await motion.apply(samples,signal);signal.throwIfAborted();readPosition();state='completed';clearTimer();release?.();release=undefined;}
   }
   signal.throwIfAborted();token=randomUUID();if(state==='awaiting')arm();const value=copy();last={token:consumed,key,value:structuredClone(value)};return value;
  }catch(error){await terminate(error).catch(()=>{});throw new ApiError(503,'Manual calibration stopped; reinitialize before further motion');}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return ()=>{if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;closed=true;unregister();unsubscribe();clearTimer();const stop=stopping??(release||pending?terminate(new Error('Manual calibration closed')):Promise.resolve());void Promise.allSettled([stop,pending?.catch(()=>{})]).then(results=>{const result=results[0];if(result.status==='rejected')done.reject(result.reason);else done.resolve();});return closing;};
}
