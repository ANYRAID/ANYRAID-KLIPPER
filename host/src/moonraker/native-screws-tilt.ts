import type {ScrewDirection} from '../motion/screws-tilt.ts';
import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
/** Typed homing/probe/grid maintenance; no client script or motion target.
 * The product supplies configured geometry and the native operation owner. */
export function registerNativeScrewsTilt(registry:EndpointRegistry,gate:MaintenanceGate,motion:{idle():boolean;measure(signal:AbortSignal,direction?:ScrewDirection,maximumDeviation?:number):Promise<Json>;synchronize():void;fail(cause:unknown):Promise<void>}){
 let token=randomUUID(),state:'ready'|'measuring'|'failed'='ready',closed=false;
 let last:{token:string;request:string;receipt:Json}|undefined,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>({state_token:token,state,available:!closed&&state==='ready'&&gate.available&&motion.idle()});
 const releases=[registry.register({endpoint:'/printer/calibration/screws_tilt',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','direction','maximum_deviation'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  if(params.direction!==undefined&&params.direction!=='CW'&&params.direction!=='CCW'||params.maximum_deviation!==undefined&&(typeof params.maximum_deviation!=='number'||!Number.isFinite(params.maximum_deviation)||params.maximum_deviation<0))throw new ApiError(400,'Invalid screw direction or maximum deviation');
  const request=JSON.stringify([params.direction??null,params.maximum_deviation??null]);
  if(closed)throw new ApiError(503,'Probe owner closed');
  if(last?.token===params.state_token){if(last.request!==request)throw new ApiError(409,'Screw measurement retry conflicts');return structuredClone(last.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale probe state token');
  if(state!=='ready'||!motion.idle())throw new ApiError(409,'Screw measurement requires an idle homed printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks probe');}
  state='measuring';const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Probe deadline exceeded')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{
   signal.throwIfAborted();const result=await motion.measure(signal,params.direction as ScrewDirection|undefined,params.maximum_deviation as number|undefined);signal.throwIfAborted();motion.synchronize();
   token=randomUUID();state='ready';release();const receipt={...snapshot(),result};last={token:consumed,request,receipt:structuredClone(receipt)};return receipt;
  }catch(error){state='failed';gate.invalidate();await motion.fail(error).catch(()=>{});throw new ApiError(503,'Screw measurement failed; reinitialize before further motion');}
  finally{clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 })];
 return async()=>{closed=true;lifetime.abort(new Error('Probe owner closed'));for(const release of releases)release();await pending?.catch(()=>{});};
}
