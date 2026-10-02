import {randomUUID} from 'node:crypto';
import {ApiError} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {ObjectCommands} from '../gcode/object-commands.ts';
export interface ObjectCancellationPort {
 snapshot():{requestId:string|null;state:string;stateToken:string;available:boolean};
 assertActive():void;
}
/** Synchronous future-admission change: never queues behind a paused file's
 * dispatch lease and never removes motion already accepted by the planner. */
export function registerNativeObjectCancellation(registry:EndpointRegistry,objects:ObjectCommands,port:ObjectCancellationPort){
 let token=randomUUID(),fingerprint='',closed=false;
 const snapshot=()=>{const print=port.snapshot(),status=objects.status,next=JSON.stringify([print.requestId,print.stateToken,objects.revision]);if(next!==fingerprint){fingerprint=next;token=randomUUID();}return {state_token:token,request_id:print.requestId,available:!closed&&print.available&&print.requestId!==null&&['printing','paused'].includes(print.state),...status,applies_to:'future_admissions'};};
 let previous:{token:string;name:string;fingerprint:string;receipt:ReturnType<typeof snapshot>}|undefined;
 const remove=registry.register({endpoint:'/printer/print/objects',methods:['GET','POST']},(params,verb,context)=>{
  if(verb==='GET')return snapshot();
  if(Object.keys(params).some(k=>!['version','state_token','name'].includes(k))||params.version!==1||typeof params.state_token!=='string'||typeof params.name!=='string'||!params.name||params.name.length>256||/[\x00-\x1f\x7f]/u.test(params.name))throw new ApiError(400,'Expected version, state_token and object name');
  context.signal.throwIfAborted();const state=snapshot(),name=params.name;
  if(closed)throw new ApiError(503,'Object cancellation owner closed');
  if(previous?.token===params.state_token&&previous.fingerprint===fingerprint){if(previous.name!==name)throw new ApiError(409,'Object cancellation retry conflicts');return structuredClone(previous.receipt);}
  if(params.state_token!==token)throw new ApiError(409,'Stale object cancellation token');
  if(!state.available)throw new ApiError(409,'Object cancellation requires an active print');
  if(!state.objects.some(o=>o.name===name))throw new ApiError(400,'Unknown object name');
  port.assertActive();const consumed=token;objects.exclude(name);token=randomUUID();const receipt=snapshot();previous={token:consumed,name,fingerprint,receipt:structuredClone(receipt)};return receipt;
 });
 return ()=>{closed=true;remove();};
}
