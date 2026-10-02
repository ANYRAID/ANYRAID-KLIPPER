import {randomUUID} from 'node:crypto';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MaintenanceGate} from '../operations/maintenance-gate.ts';
import type {BedMeshProfiles} from '../motion/bed-mesh-profiles.ts';
import type {BedMesh} from '../motion/bed-mesh.ts';
export function registerNativeBedMeshSelection(registry:EndpointRegistry,gate:MaintenanceGate,profiles:BedMeshProfiles,port:{snapshot():{revision:unknown;profile:string};idle():boolean;set(mesh:BedMesh|null,name:string,signal:AbortSignal):Promise<void>;fail(cause:unknown):Promise<void>}){
 let token=randomUUID(),revision:unknown,closed=false,pending:Promise<Json>|undefined,receipt:{token:string;key:string;revision:unknown;value:Json}|undefined;
 const lifetime=new AbortController();
 const snapshot=()=>{const state=port.snapshot();if(state.revision!==revision){revision=state.revision;token=randomUUID();}return {state_token:token,profile:state.profile,profiles:[...profiles.names],available:!closed&&!pending&&gate.available&&port.idle(),persisted:false};};
 const unregister=registry.register({endpoint:'/printer/settings/bed_mesh',methods:['GET','POST']},async(params,verb,context)=>{
  context.signal.throwIfAborted();if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Expected no query parameters');return snapshot();}
  if(Object.keys(params).some(k=>!['version','state_token','action','profile'].includes(k))||params.version!==1||typeof params.state_token!=='string'||!['load','clear'].includes(String(params.action)))throw new ApiError(400,'Expected version, state_token and load or clear action');
  if(params.action==='clear'&&params.profile!==undefined||params.action==='load'&&(typeof params.profile!=='string'||!profiles.names.includes(params.profile)))throw new ApiError(400,'Invalid bed mesh profile');
  if(closed||gate.status.closed)throw new ApiError(503,'Bed mesh selection unavailable');
  const state=snapshot(),key=JSON.stringify([params.action,params.profile??null]);
  if(receipt?.token===params.state_token&&receipt.revision===revision){if(receipt.key!==key)throw new ApiError(409,'Bed mesh selection retry conflicts');return structuredClone(receipt.value);}
  if(params.state_token!==token)throw new ApiError(409,'Stale bed mesh selection token');
  if(!state.available)throw new ApiError(409,'Bed mesh selection requires idle homed printer');
  const mesh=params.action==='load'?profiles.load(params.profile as string):null,name=params.action==='load'?params.profile as string:'';
  let release:()=>void;try{release=gate.acquire();}catch{throw new ApiError(409,'Printer activity blocks mesh selection');}
  const consumed=token,deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Mesh selection deadline')),30000),signal=AbortSignal.any([context.signal,lifetime.signal,deadline.signal]);
  pending=(async()=>{try{signal.throwIfAborted();await port.set(mesh,name,signal);signal.throwIfAborted();token=randomUUID();const value={...snapshot(),available:false};receipt={token:consumed,key,revision,value:structuredClone(value)};return value;}
   catch(error){gate.invalidate();await port.fail(error).catch(()=>{});throw new ApiError(503,'Mesh selection failed; reinitialize printer');}
   finally{clearTimeout(timer);release();}})();
  try{return await pending;}finally{pending=undefined;}
 });
 return async()=>{closed=true;unregister();lifetime.abort(new Error('Mesh selection closed'));await pending?.catch(()=>{});};
}
