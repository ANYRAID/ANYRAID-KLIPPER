import {randomUUID} from 'node:crypto';
import {ApiError,authorizedContext,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
export interface DriverCurrentMaintenance {
 snapshot():readonly {name:string;revision:number;run_current:number;hold_current:number;max_current:number}[];
 idle():boolean;
 set(name:string,change:{run?:number;hold?:number},signal:AbortSignal):Promise<void>;
 fail(cause:unknown):void;
 canQueue?():boolean;
 reserveExclusive?(work:(signal:AbortSignal,begin:()=>void)=>Promise<void>,signal:AbortSignal):Promise<void>;
}
/** Generation and driver-revision fenced maintenance. A bounded receipt permits
 * exact retries without replaying writes; G-code changes invalidate old tokens. */
export function registerNativeDriverCurrent(registry:EndpointRegistry,gate:MaintenanceGate,port:DriverCurrentMaintenance){
 if((port.canQueue!==undefined||port.reserveExclusive!==undefined)&&(typeof port.canQueue!=='function'||typeof port.reserveExclusive!=='function'))throw new TypeError('Current admission requires both queue and exclusive owners');
 const reserve=port.reserveExclusive?.bind(port),canQueue=port.canQueue?.bind(port);
 let token=randomUUID(),fingerprint='',closed=false,failed=false,busy=false,pending:Promise<Json>|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{
  const drivers=port.snapshot(),next=JSON.stringify(drivers.map(d=>[d.name,d.revision]));
  if(next!==fingerprint){fingerprint=next;token=randomUUID();}
  return {state_token:token,drivers:drivers.map(({revision,...driver})=>driver),persisted:false,available:!closed&&!failed&&!busy&&gate.available&&port.idle()&&(!reserve||canQueue!()===true)};
 };
 let previous:{token:string;key:string;fingerprint:string;receipt:ReturnType<typeof snapshot>}|undefined;
 const unregister=registry.register({endpoint:'/printer/settings/driver_current',methods:['GET','POST']},async(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','driver','run_current','hold_current'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.driver!=='string'||!['run_current','hold_current'].some(k=>Object.hasOwn(params,k)))throw new ApiError(400,'Expected version, state_token, driver and current');
  for(const k of ['run_current','hold_current'])if(Object.hasOwn(params,k)){const n=params[k];if(typeof n!=='number'||!Number.isFinite(n)||n<0||(k==='hold_current'&&n===0))throw new ApiError(400,'Invalid driver current');}
  const owned=Object.freeze({...params}),state=snapshot(),key=JSON.stringify([owned.driver,owned.run_current??null,owned.hold_current??null]);
  if(closed||failed||gate.status.closed)throw new ApiError(503,'Driver current owner unavailable');
  if(previous?.token===params.state_token&&previous.fingerprint===fingerprint){if(previous.key!==key)throw new ApiError(409,'Driver current retry conflicts');return structuredClone(previous.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale driver current state token');
  const driver=state.drivers.find(d=>d.name===params.driver);if(!driver)throw new ApiError(400,'Unknown current driver');
  if(['run_current','hold_current'].some(k=>typeof params[k]==='number'&&params[k]>driver.max_current))throw new ApiError(400,'Current exceeds driver limit');
  if(busy||(reserve?canQueue!()!==true:!state.available))throw new ApiError(409,'Driver current requires an idle printer');
  busy=true;const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Current adjustment deadline exceeded')),10000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  const execute=async(s:AbortSignal,begin:()=>void):Promise<Json>=>{
   s.throwIfAborted();
   if(reserve){
    let abort=()=>{};const cancelled=new Promise<never>((_resolve,reject)=>{abort=()=>reject(s.reason);s.addEventListener('abort',abort,{once:true});});
    try{const identity=authorizedContext(context,await Promise.race([Promise.resolve().then(()=>{s.throwIfAborted();return context.authorize('printer.settings.post_driver_current',owned);}),cancelled]));if(identity.user?.username!==context.user?.username)throw new ApiError(403,'Current adjustment identity changed');}
    finally{s.removeEventListener('abort',abort);}
   }
   s.throwIfAborted();const current=snapshot();
   if(closed||failed||gate.status.closed)throw new ApiError(503,'Driver current owner unavailable');
   if(owned.state_token!==token)throw new ApiError(409,'Stale driver current state token');
   const selected=current.drivers.find(d=>d.name===owned.driver);if(!selected)throw new ApiError(400,'Unknown current driver');
   if(['run_current','hold_current'].some(k=>typeof owned[k]==='number'&&owned[k]>selected.max_current))throw new ApiError(400,'Current exceeds driver limit');
   if(!port.idle())throw new ApiError(409,'Driver current requires an idle printer');
   let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks current adjustment');}
   let started=false;try{
    s.throwIfAborted();begin();started=true;await port.set(owned.driver as string,{run:owned.run_current as number|undefined,hold:owned.hold_current as number|undefined},s);s.throwIfAborted();
    busy=false;release();token=randomUUID();const receipt=snapshot();previous={token:consumed,key,fingerprint,receipt:structuredClone(receipt)};return receipt;
   }catch(error){if(!started)throw error;failed=true;gate.invalidate();port.fail(error);throw new ApiError(503,'Driver current adjustment failed; reinitialize required');}
   finally{release();}
  };
  pending=!reserve?execute(signal,()=>{}):Promise.resolve().then(async()=>{signal.throwIfAborted();if(canQueue!()!==true)throw new ApiError(409,'Printer activity blocks current adjustment');let result:Json|undefined;await reserve(async(s,begin)=>{result=await execute(s,begin);},signal);return result!;});
  try{return await pending;}finally{busy=false;clearTimeout(timer);pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Driver current owner closed'));unregister();await pending?.catch(()=>{});};
}
