import {ApiError} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MoonrakerNetwork} from './server.ts';
import type {KlippyLifecycle} from './klippy-lifecycle.ts';
import type {DeliveryReport} from './notifications.ts';
/** A client owns its registration for exactly one connection and Klippy
 * generation. Outbound authorization runs in the network's bounded queue,
 * never as asynchronous work on the Klippy callback lane. */
export class AgentMethods {
 #metrics={received:0,rejected:0,sent:0,denied:0,closed:0,overflow:0,failed:0};
 #release:()=>void;#owner=new AbortController();
 constructor(registry:EndpointRegistry,network:MoonrakerNetwork,runtime:()=>KlippyLifecycle|undefined){
  this.#release=registry.register({endpoint:'/server/connection/register_remote_method',methods:['POST'],transports:['websocket']},async(params,_verb,context)=>{
   const id=context.connectionId,client=id===undefined?undefined:network.getClient(id);
   if(!client)throw new ApiError(400,'No connection detected');
   if(client.identity?.type!=='agent')throw new ApiError(400,"Only connections of the 'agent' type can register remote methods");
   const name=params.method_name;
   if(typeof name!=='string'||!name||name.length>256||name.includes('\0'))throw new ApiError(400,'Invalid remote method name');
   if(!network.status.clientCalls)throw new ApiError(503,'Client call authorization is required');
   const klippy=runtime();if(!klippy)throw new ApiError(503,'Klippy remote methods unavailable');
   await klippy.registerLiveRemoteMethod(name,(values,lifetime)=>{
    this.#metrics.received++;
    const consume=(report:DeliveryReport)=>{for(const key of ['sent','denied','closed','overflow','failed'] as const)this.#metrics[key]+=report[key];};
    try{const result=network.dispatchClientCall(client.id,name,values,lifetime);if('then' in result)void result.then(consume,()=>{this.#metrics.rejected++;});else consume(result);}catch{this.#metrics.rejected++;}
   },AbortSignal.any([network.connectionSignal(client.id),this.#owner.signal]),{signal:context.signal});
   return 'ok';
  });
 }
 get metrics(){return {...this.#metrics};}
 close(){this.#owner.abort();this.#release();}
}
