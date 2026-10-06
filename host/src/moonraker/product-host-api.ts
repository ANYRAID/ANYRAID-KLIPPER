import {RestartAdmissionError,type ProductHostControl} from '../runtime/product-host-control.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {ApiError} from './rpc.ts';
import {MachineControlError,type MachineAction} from './machine-control.ts';
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
 const machine=(endpoint:string,action:(params:Record<string,unknown>)=>MachineAction)=>registry.register({endpoint,methods:['POST'],transports:['http','websocket']},async(params,_verb,context)=>{
  const request=action(params);if(!context.afterResponse)throw new ApiError(503,'Response handoff is unavailable');
  try{await control.requestMachineAction(request,context.nativeGenerationSignal,context.nativeGenerationRetiredAtAdmission,callback=>context.afterResponse!(callback));return 'ok';}
  catch(error){throw new ApiError(error instanceof RestartAdmissionError?error.status:error instanceof MachineControlError&&error.code==='not_allowed'?403:control.status.storage_failed?503:409,error instanceof Error?error.message:'Machine action rejected');}
 });
 const serviceActions=(['start','stop','restart'] as const).map(action=>machine('/machine/services/'+action,params=>{
  if(Object.keys(params).length!==1||typeof params.service!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,239}$/u.test(params.service))throw new ApiError(400,'Expected an allowed service name');return {kind:'service',action,service:params.service};
 }));
 const processActions=(['server_restart','reboot','shutdown'] as const).map(kind=>machine(kind==='server_restart'?'/server/restart':'/machine/'+kind,params=>{
  if(Object.keys(params).length)throw new ApiError(400,'Machine action takes no arguments');return {kind};
 }));
 const script=registry.register({endpoint:'/printer/gcode/script',methods:['POST'],transports:['http','websocket']},async(params,_verb,context)=>{
  if(Object.keys(params).some(k=>k!=='script')||typeof params.script!=='string'||!['RESTART','FIRMWARE_RESTART'].includes(params.script.trim().toUpperCase()))throw new ApiError(400,'Native script compatibility supports only standard restart commands');
  if(!context.afterResponse)throw new ApiError(503,'Response handoff is unavailable');
  try{const request=params.script.trim().toUpperCase()==='RESTART'?control.requestRestart.bind(control):control.requestFirmwareRestart.bind(control);await request(context.nativeGenerationSignal,context.nativeGenerationRetiredAtAdmission,callback=>context.afterResponse!(callback));return 'ok';}
  catch(error){throw new ApiError(error instanceof RestartAdmissionError?error.status:control.status.storage_failed?503:409,error instanceof Error?error.message:'Restart rejected');}
 });
 return ()=>{script();for(const remove of [...processActions,...serviceActions])remove();firmwareRestart();restart();reinitialize();status();};
}
