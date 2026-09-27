import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
export interface ZAdjustmentPort {
 snapshot():{offset:number;revision:string;position:readonly number[];printToken:string;minimum:number;maximum:number};
 idle():boolean;
 adjust(delta:number,signal:AbortSignal):Promise<void>;
 stop(cause:unknown):Promise<void>;
}
/** Calibration movement at rest. Retained paused trajectories require a separate
 * rebasing protocol; this owner must never enter their motion/dispatch lease. */
export function registerNativeZAdjustment(registry:EndpointRegistry,gate:MaintenanceGate,port:ZAdjustmentPort){
 let token=randomUUID(),fingerprint='',closed=false,busy=false,failed=false,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{
  const value=port.snapshot(),next=JSON.stringify(value);
  if(next!==fingerprint){fingerprint=next;token=randomUUID();}
  return {state_token:token,z_offset:value.offset,position:[...value.position],minimum:value.minimum,maximum:value.maximum,max_adjustment:.1,speed:5,persisted:false,available:!closed&&!failed&&!busy&&gate.available&&port.idle()};
 };
 let previous:{token:string;delta:number;fingerprint:string;receipt:ReturnType<typeof snapshot>}|undefined;
 const unregister=registry.register({endpoint:'/printer/calibration/z_offset',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','adjust'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.adjust!=='number'||!Number.isFinite(params.adjust)||params.adjust===0||Math.abs(params.adjust)>.1)throw new ApiError(400,'Expected version, state_token and nonzero Z adjust within 0.1 mm');
  if(closed||failed||gate.status.closed)throw new ApiError(503,'Z adjustment owner unavailable');
  const state=snapshot(),delta=params.adjust;
  if(previous?.token===params.state_token&&previous.fingerprint===fingerprint){if(previous.delta!==delta)throw new ApiError(409,'Z adjustment retry conflicts');return structuredClone(previous.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale Z adjustment state token');
  if(!state.available)throw new ApiError(409,'Z adjustment requires an idle homed printer');
  const target=state.position[2]+delta;
  if(!Number.isFinite(target)||!Number.isFinite(state.z_offset+delta)||target<state.minimum||target>state.maximum)throw new ApiError(400,'Z adjustment exceeds travel limits');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks Z adjustment');}
  busy=true;const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Z adjustment deadline exceeded')),30000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{
   signal.throwIfAborted();await port.adjust(delta,signal);signal.throwIfAborted();
   busy=false;release();token=randomUUID();const receipt=snapshot();previous={token:consumed,delta,fingerprint,receipt:structuredClone(receipt)};return receipt;
  }catch(error){failed=true;gate.invalidate();await port.stop(error).catch(()=>{});throw new ApiError(503,'Z adjustment failed; reinitialize and home before retry');}
  finally{busy=false;clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Z adjustment owner closed'));unregister();await pending?.catch(()=>{});};
}
