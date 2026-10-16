import {randomUUID} from 'node:crypto';
import {ApiError,authorizedContext,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
/** Typed homing/probe/grid maintenance; no client script or motion target.
 * The product supplies configured geometry and the native operation owner. */
export function registerNativeProbe(registry:EndpointRegistry,gate:MaintenanceGate,motion:{idle():boolean;measure(signal:AbortSignal,axes?:readonly (0|1|2)[]):Promise<Json>;synchronize():void;canQueue?():boolean;reserveExclusive?(work:(signal:AbortSignal,begin:()=>void)=>Promise<void>,signal:AbortSignal):Promise<void>},kind:'probe'|'bed_mesh'|'bed_tilt'|'z_tilt'|'quad_gantry_level'|'home'='probe'){
 if((motion.canQueue!==undefined||motion.reserveExclusive!==undefined)&&(typeof motion.canQueue!=='function'||typeof motion.reserveExclusive!=='function'))throw new TypeError('Maintenance admission requires both queue and exclusive owners');
 const reserve=motion.reserveExclusive?.bind(motion),canQueue=motion.canQueue?.bind(motion);
 let token=randomUUID(),state:'ready'|'measuring'|'failed'='ready',closed=false;
 let last:{token:string;receipt:Json;axes:string}|undefined;const pending=new Set<Promise<Json>>();
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
  if(state!=='ready'||reserve&&canQueue!()!==true)throw new ApiError(409,kind==='home'?'Homing requires an idle printer':'Probe requires an idle homed printer');
  const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Probe deadline exceeded')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  const execute=async(ownedSignal:AbortSignal,begin:()=>void):Promise<Json>=>{
   ownedSignal.throwIfAborted();
   // The existing clock worker may have owned the lane before this request.
   // Recheck authority and all original guards after that ownership retires.
   if(reserve){
    let abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(ownedSignal.reason);ownedSignal.addEventListener('abort',abort,{once:true});});
    try{const identity=authorizedContext(context,await Promise.race([Promise.resolve().then(()=>{ownedSignal.throwIfAborted();return context.authorize('printer.calibration.post_'+kind,params);}),cancelled]));if(identity.user?.username!==context.user?.username)throw new ApiError(403,'Probe identity changed');}
    finally{ownedSignal.removeEventListener('abort',abort);}
   }
   ownedSignal.throwIfAborted();if(closed)throw new ApiError(503,'Probe owner closed');
   if(last?.token===params.state_token){if(last.axes!==axesKey)throw new ApiError(409,'Consumed home token belongs to different axes');return structuredClone(last.receipt);}
   if(params.state_token!==token)throw new ApiError(409,'Stale probe state token');
   if(state!=='ready'||!motion.idle())throw new ApiError(409,kind==='home'?'Homing requires an idle printer':'Probe requires an idle homed printer');
   let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks probe');}
   const consumed=token;state='measuring';
   try{
    ownedSignal.throwIfAborted();begin();const result=await motion.measure(ownedSignal,axes);ownedSignal.throwIfAborted();motion.synchronize();
    token=randomUUID();state='ready';release();const receipt={...snapshot(),result};last={token:consumed,receipt:structuredClone(receipt),axes:axesKey};return receipt;
   }catch{state='failed';gate.invalidate();throw new ApiError(503,kind==='home'?'Homing failed; reinitialize before further motion':'Probe failed; reinitialize before further motion');}
   finally{release();}
  };
  const task=!reserve?execute(signal,()=>{}):Promise.resolve().then(async()=>{let result:Json|undefined;
   signal.throwIfAborted();if(canQueue!()!==true)throw new ApiError(409,'Printer activity blocks probe');
   await reserve(async(s,begin)=>{result=await execute(s,begin);},signal);return result!;
  });pending.add(task);
  try{return await task;}finally{clearTimeout(timer);pending.delete(task);}
 })];
 return async()=>{closed=true;lifetime.abort(new Error('Probe owner closed'));for(const release of releases)release();await Promise.allSettled([...pending]);};
}
