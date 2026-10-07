import {ApiError} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import {PrintLayerPause} from '../operations/print-layer-pause.ts';
/** Uses the registry's transport authorization and generation retirement fence.
 * No macro command, auto resume, physical recipe or persisted action. */
export function registerNativeLayerPause(registry:EndpointRegistry,owner:PrintLayerPause):()=>void{
 if(!(owner instanceof PrintLayerPause))throw new TypeError('Invalid layer pause owner');
 let off:()=>void;
 try{off=registry.register({endpoint:'/printer/print/layer_pause',methods:['GET','POST','DELETE']},(params,verb)=>{
  if(verb==='GET'){if(Object.keys(params).length)throw new ApiError(400,'Layer pause query takes no parameters');return owner.status;}
  const keys=verb==='POST'?['version','request_id','print_state_token','state_token','layer','expires_at']:['version','request_id','print_state_token','state_token'];
  if(Object.keys(params).some(key=>!keys.includes(key))||params.version!==1||typeof params.request_id!=='string'||typeof params.print_state_token!=='string'||typeof params.state_token!=='string'||[params.request_id,params.print_state_token,params.state_token].some(value=>value.length>128))throw new ApiError(400,'Expected version, request identity and both state tokens');
  if(verb==='POST'&&(params.layer!=='next'&&typeof params.layer!=='number'||typeof params.expires_at!=='number'))throw new ApiError(400,'Expected next or numeric layer and expiry');
  try{if(verb==='POST')owner.arm(params.request_id,params.print_state_token,params.state_token,params.layer as 'next'|number,params.expires_at as number);else owner.clear(params.request_id,params.print_state_token,params.state_token);}
  catch(error){if(error instanceof RangeError)throw new ApiError(400,error.message);throw new ApiError(409,'Layer pause state changed or is unavailable; query before retrying');}
  return owner.status;
 });}catch(error){owner.close();throw error;}
 return ()=>{off();owner.close();};
}
