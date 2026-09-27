import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
/** One typed single-point measurement at current XY; no script or motion target
 * accepted from clients. The machine supplies the configured Z search limit. */
export function registerNativeProbe(registry:EndpointRegistry,gate:MaintenanceGate,motion:{idle():boolean;measure(signal:AbortSignal):Promise<Json>;synchronize():void},kind:'probe'|'bed_mesh'='probe'){
 let token=randomUUID(),state:'ready'|'measuring'|'failed'='ready',closed=false;
 let last:{token:string;receipt:Json}|undefined,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>({state_token:token,state,available:!closed&&state==='ready'&&!gate.status.closed&&motion.idle()});
 const releases=[registry.register({endpoint:'/printer/calibration/'+kind,methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token'].includes(k))||params.version!==1||typeof params.state_token!=='string')throw new ApiError(400,'Expected version and state_token');
  if(closed)throw new ApiError(503,'Probe owner closed');
  if(last?.token===params.state_token)return structuredClone(last.receipt);
  if(params.state_token!==token)throw new ApiError(409,'Stale probe state token');
  if(state!=='ready'||!motion.idle())throw new ApiError(409,'Probe requires an idle homed printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks probe');}
  state='measuring';const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Probe deadline exceeded')),120000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{
   signal.throwIfAborted();const result=await motion.measure(signal);signal.throwIfAborted();motion.synchronize();
   token=randomUUID();state='ready';const receipt={...snapshot(),result};last={token:consumed,receipt:structuredClone(receipt)};return receipt;
  }catch{state='failed';gate.invalidate();throw new ApiError(503,'Probe failed; reinitialize before further motion');}
  finally{clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 })];
 return async()=>{closed=true;lifetime.abort(new Error('Probe owner closed'));for(const release of releases)release();await pending?.catch(()=>{});};
}
