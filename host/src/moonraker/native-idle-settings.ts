import {randomUUID} from 'node:crypto';
import {ApiError} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {ProductIdleTimeout} from '../operations/product-idle.ts';
/** Runtime setting with generation-scoped compare-and-set and bounded retry
 * receipt. Retrying an accepted request must not extend the timeout again. */
export function registerNativeIdleSettings(registry:EndpointRegistry,idle:ProductIdleTimeout,available:()=>boolean):()=>void{
 let token=randomUUID(),closed=false;
 const snapshot=()=>({state_token:token,timeout:idle.status.idle_timeout,persisted:false,available:!closed&&available()&&idle.updatable});
 let previous:{token:string;timeout:number;receipt:ReturnType<typeof snapshot>}|undefined;
 const unregister=registry.register({endpoint:'/printer/settings/idle_timeout',methods:['GET','POST']},(params,verb)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','timeout'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.timeout!=='number'||!Number.isFinite(params.timeout)||params.timeout<=0||params.timeout>86400)throw new ApiError(400,'Expected version, state_token and timeout in (0, 86400]');
  if(closed||!available()||idle.status.closed)throw new ApiError(409,'Idle setting owner unavailable');
  if(previous?.token===params.state_token){if(previous.timeout!==params.timeout)throw new ApiError(409,'Idle setting retry conflicts');return {...previous.receipt};}
  if(params.state_token!==token)throw new ApiError(409,'Stale idle setting state token');
  try{idle.setTimeout(params.timeout);}catch{throw new ApiError(409,'Idle timeout is already expiring');}
  const consumed=token;token=randomUUID();const receipt=snapshot();previous={token:consumed,timeout:params.timeout,receipt};return {...receipt};
 });
 return ()=>{closed=true;unregister();};
}
