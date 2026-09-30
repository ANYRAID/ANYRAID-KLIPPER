import {RestartAdmissionError,type ProductHostControl} from '../runtime/product-host-control.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError} from './rpc.ts';
/** Explicit product operation, separate from legacy Klippy restart semantics.
 * EndpointRegistry authorizes every status and mutation before this handler. */
export function registerProductHostControl(registry:EndpointRegistry,control:ProductHostControl):()=>void{
 const status=registry.register({endpoint:'/printer/host/status',methods:['GET'],transports:['http','websocket']},params=>{
  if(Object.keys(params).some(k=>k!=='request_id')||params.request_id!==undefined&&(typeof params.request_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(params.request_id)))throw new ApiError(400,'Invalid host status query');
  return {...control.status,...params.request_id===undefined?{}:{operation:control.operation(params.request_id as string)}};
 });
 const reinitialize=registry.register({endpoint:'/printer/host/reinitialize',methods:['POST'],transports:['http','websocket']},async(params,_verb,context)=>{
  if(Object.keys(params).some(k=>!['version','request_id','state_token'].includes(k))||params.version!==1||typeof params.request_id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(params.request_id)||typeof params.state_token!=='string'||params.state_token.length>128)throw new ApiError(400,'Expected version 1, request_id and host state_token');
  if(!context.afterResponse)throw new ApiError(503,'Response handoff is unavailable');
  try{return {accepted:true,operation:{...await control.request(params.request_id,params.state_token,callback=>context.afterResponse!(callback))}};}
  catch(error){throw new ApiError(control.status.storage_failed?503:409,error instanceof Error?error.message:'Reinitialization rejected');}
 });
 const standard=(kind:'restart'|'firmware_restart')=>registry.register({endpoint:'/printer/'+kind,methods:['POST'],transports:['http','websocket']},async(params,_verb,context)=>{
  if(Object.keys(params).length)throw new ApiError(400,kind.toUpperCase()+' takes no arguments');
  if(!context.afterResponse)throw new ApiError(503,'Response handoff is unavailable');
  try{const request=kind==='restart'?control.requestRestart.bind(control):control.requestFirmwareRestart.bind(control);await request(context.nativeGenerationSignal,context.nativeGenerationRetiredAtAdmission,callback=>context.afterResponse!(callback));return 'ok';}
  catch(error){throw new ApiError(error instanceof RestartAdmissionError?error.status:control.status.storage_failed?503:409,error instanceof Error?error.message:'Restart rejected');}
 });
 const restart=standard('restart'),firmwareRestart=standard('firmware_restart');
 return ()=>{firmwareRestart();restart();reinitialize();status();};
}
