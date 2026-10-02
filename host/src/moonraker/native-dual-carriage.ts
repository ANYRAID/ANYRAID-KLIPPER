import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {CarriageMode} from '../kinematics/dual-carriage.ts';
/** One receipt per generation; a retry never performs a second physical rebase. */
export function registerNativeDualCarriage(registry:EndpointRegistry,gate:MaintenanceGate,port:{snapshot():{generation:unknown;state:Json};idle():boolean;validate(index:0|1,mode:CarriageMode):void;set(index:0|1,mode:CarriageMode,signal:AbortSignal):Promise<void>;fail(cause:unknown):Promise<void>}){
 let token=randomUUID(),generation:unknown,fingerprint='',closed=false,pending:Promise<Json>|undefined;
 let receipt:{token:string;request:string;generation:unknown;fingerprint:string;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{const next=port.snapshot(),key=JSON.stringify(next.state);if(next.generation!==generation||key!==fingerprint){generation=next.generation;fingerprint=key;token=randomUUID();}return {state_token:token,state:next.state,available:!closed&&!pending&&gate.available&&port.idle(),persisted:false};};
 const remove=registry.register({endpoint:'/printer/settings/dual_carriage',methods:['GET','POST']},async(params,verb,context)=>{
  context.signal.throwIfAborted();
  if(closed||gate.status.closed)throw new ApiError(503,'Dual carriage settings closed');
  if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Expected no query parameters');return snapshot();}
  if(Object.keys(params).some(k=>!['version','state_token','carriage','mode'].includes(k))||params.version!==1||typeof params.state_token!=='string'||(params.carriage!==0&&params.carriage!==1)||typeof params.mode!=='string'||!['PRIMARY','INACTIVE','COPY','MIRROR'].includes(params.mode))throw new ApiError(400,'Expected version, state_token, carriage and mode');
  const index=params.carriage,mode=params.mode as CarriageMode,state=snapshot(),request=JSON.stringify([index,mode]);
  if(receipt?.token===params.state_token&&receipt.generation===generation&&receipt.fingerprint===fingerprint){if(receipt.request!==request)throw new ApiError(409,'Dual carriage retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale dual carriage state token');
  if(!state.available)throw new ApiError(409,'Dual carriage settings require an idle printer');
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks dual carriage settings');}
  try{port.validate(index,mode);}catch{release();throw new ApiError(409,'Unsafe dual carriage mode or position');}
  const consumed=token,signal=AbortSignal.any([context.signal,lifetime.signal,AbortSignal.timeout(30000)]);
  pending=(async()=>{try{signal.throwIfAborted();await port.set(index,mode,signal);signal.throwIfAborted();token=randomUUID();const value={...snapshot(),available:false};receipt={token:consumed,request,generation,fingerprint,value:structuredClone(value)};return value;}
   catch(error){gate.invalidate();await port.fail(error).catch(()=>{});throw new ApiError(503,'Dual carriage change failed; reinitialize printer');}
   finally{release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;lifetime.abort(new Error('Dual carriage settings closed'));remove();await pending?.catch(()=>{});};
}
