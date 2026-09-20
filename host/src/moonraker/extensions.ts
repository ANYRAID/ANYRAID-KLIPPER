// Extension endpoint behavior follows pinned Moonraker ExtensionManager.
// Original Copyright (C) 2022 Eric Callahan. GPL-3.0-or-later.
import {EndpointRegistry} from './endpoints.ts';
import {ApiError,type Json} from './rpc.ts';
import type {RemoteClient} from './clients.ts';
import type {ClientArguments,ClientRequestOptions} from './client-requests.ts';
export interface ExtensionHost {
 getClient(id:number):RemoteClient|undefined;
 getAgent(name:string):RemoteClient|undefined;
 getAgents():readonly RemoteClient[];
 requestClient(id:number,method:string,params:ClientArguments,options:ClientRequestOptions):Promise<Json>;
 broadcast(method:string,params:readonly Json[],excluded:readonly number[]):Promise<unknown>;
}
function string(params:Readonly<Record<string,Json>>,key:string,max=4096):string{
 if(!Object.hasOwn(params,key))throw new ApiError(400,`No data for argument: ${key}`);
 const value=params[key];if(typeof value!=='string'||value.length>max)throw new ApiError(400,`Argument [${key}] must be a string of at most ${max} characters`);return value;
}
/** Registration is transactional across the three routes. Identity is read
 * from live connections; inbound and outbound authorization remain independent.
 * Klippy remote-method registration is owned by the future Klippy bridge. */
export function registerExtensions(registry:EndpointRegistry,host:ExtensionHost):()=>void{
 const releases:(()=>void)[]=[];
 try{
  releases.push(registry.register({endpoint:'/server/extensions/list',methods:['GET']},()=>({agents:host.getAgents().map(c=>({...c.identity!}))})));
  releases.push(registry.register({endpoint:'/server/extensions/request',methods:['POST']},(params,_verb,context)=>{
   const agent=string(params,'agent'),method=string(params,'method',256),args=params.arguments??null;
   if(!method)throw new ApiError(400,'Invalid client method');
   if(args!==null&&(typeof args!=='object'||!args))throw new ApiError(400,"The 'arguments' field must contain an object or a list");
   const client=host.getAgent(agent);if(!client)throw new ApiError(400,`Agent ${agent} not connected`);
   return host.requestClient(client.id,method,args,{signal:context.signal});
  }));
  // Upstream prefixes /connection/* with server for its WebSocket RPC name.
  releases.push(registry.register({endpoint:'/server/connection/send_event',methods:['POST'],transports:['websocket']},async(params,_verb,context)=>{
   const client=context.connectionId===undefined?undefined:host.getClient(context.connectionId);
   if(!client)throw new ApiError(400,'No connection detected');
   if(client.identity?.type!=='agent')throw new ApiError(400,"Only connections of the 'agent' type can send events");
   const event=string(params,'event');if(event==='connected'||event==='disconnected')throw new ApiError(400,`Event '${event}' is reserved`);
   const payload:Json={agent:client.identity.name,event,...params.data!==undefined&&params.data!==null?{data:params.data}:{}};
   await host.broadcast('notify_agent_event',[payload],[client.id]);return 'ok';
  }));
 }catch(error){for(const release of releases.reverse())release();throw error;}
 let closed=false;return ()=>{if(closed)return;closed=true;for(const release of releases.reverse())release();};
}
