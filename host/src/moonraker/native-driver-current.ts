import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
export interface DriverCurrentMaintenance {
 snapshot():readonly {name:string;revision:number;run_current:number;hold_current:number}[];
 idle():boolean;
 set(name:string,change:{run?:number;hold?:number},signal:AbortSignal):Promise<void>;
 fail(cause:unknown):void;
}
/** Generation and driver-revision fenced maintenance. A bounded receipt permits
 * exact retries without replaying writes; G-code changes invalidate old tokens. */
export function registerNativeDriverCurrent(registry:EndpointRegistry,gate:MaintenanceGate,port:DriverCurrentMaintenance){
 let token=randomUUID(),fingerprint='',closed=false,failed=false,busy=false,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{
  const drivers=port.snapshot(),next=JSON.stringify(drivers.map(d=>[d.name,d.revision]));
  if(next!==fingerprint){fingerprint=next;token=randomUUID();}
  return {state_token:token,drivers:drivers.map(({revision,...driver})=>driver),persisted:false,available:!closed&&!failed&&!busy&&gate.available&&port.idle()};
 };
 let previous:{token:string;key:string;fingerprint:string;receipt:ReturnType<typeof snapshot>}|undefined;
 const unregister=registry.register({endpoint:'/printer/settings/driver_current',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','driver','run_current','hold_current'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.driver!=='string'||!['run_current','hold_current'].some(k=>Object.hasOwn(params,k)))throw new ApiError(400,'Expected version, state_token, driver and current');
  for(const k of ['run_current','hold_current'])if(Object.hasOwn(params,k)){const n=params[k];if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>2||(k==='hold_current'&&n===0))throw new ApiError(400,'Invalid driver current');}
  const state=snapshot(),key=JSON.stringify([params.driver,params.run_current??null,params.hold_current??null]);
  if(closed||failed||gate.status.closed)throw new ApiError(503,'Driver current owner unavailable');
  if(previous?.token===params.state_token&&previous.fingerprint===fingerprint){if(previous.key!==key)throw new ApiError(409,'Driver current retry conflicts');return structuredClone(previous.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale driver current state token');
  if(!state.drivers.some(d=>d.name===params.driver))throw new ApiError(400,'Unknown current driver');
  if(!state.available)throw new ApiError(409,'Driver current requires an idle printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks current adjustment');}
  busy=true;const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Current adjustment deadline exceeded')),10000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{
   signal.throwIfAborted();await port.set(params.driver as string,{run:params.run_current as number|undefined,hold:params.hold_current as number|undefined},signal);signal.throwIfAborted();
   busy=false;release();token=randomUUID();const receipt=snapshot();previous={token:consumed,key,fingerprint,receipt:structuredClone(receipt)};return receipt;
  }catch(error){failed=true;gate.invalidate();port.fail(error);throw new ApiError(503,'Driver current adjustment failed; reinitialize required');}
  finally{busy=false;clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Driver current owner closed'));unregister();await pending?.catch(()=>{});};
}
