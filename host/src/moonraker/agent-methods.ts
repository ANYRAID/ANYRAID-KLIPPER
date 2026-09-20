import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {MoonrakerNetwork} from './server.ts';
import type {KlippyLifecycle} from './klippy-lifecycle.ts';
import type {DeliveryReport} from './notifications.ts';
interface Registration {name:string;client:number;owner:AbortSignal;remove:()=>void;runtime?:KlippyLifecycle;release?:()=>void;pending?:Promise<void>;error?:string;}
/** Logical ownership survives printer startup; each published callback belongs
 * to one Klippy generation. Network delivery never holds its callback lane. */
export class AgentMethods {
 #metrics={received:0,rejected:0,sent:0,denied:0,closed:0,overflow:0,failed:0};
 #release:()=>void;#owner=new AbortController();#records=new Map<string,Registration>();#network:MoonrakerNetwork;
 constructor(registry:EndpointRegistry,network:MoonrakerNetwork,runtime:()=>KlippyLifecycle|undefined){
  this.#network=network;
  this.#release=registry.register({endpoint:'/server/connection/register_remote_method',methods:['POST'],transports:['websocket']},async(params,_verb,context)=>{
   const id=context.connectionId,client=id===undefined?undefined:network.getClient(id);
   if(!client)throw new ApiError(400,'No connection detected');
   if(client.identity?.type!=='agent')throw new ApiError(400,"Only connections of the 'agent' type can register remote methods");
   const name=params.method_name,klippy=runtime();
   if(typeof name!=='string'||!name||name.length>256||name.includes('\0')||name.startsWith('__mr_')||['process_status_update','process_gcode_response'].includes(name)||this.#records.has(name)||klippy?.remoteMethods.configured.includes(name))throw new ApiError(400,'Invalid or duplicate remote method');
   if(this.#records.size>=256)throw new ApiError(429,'Agent remote method capacity exceeded');
   if(!network.status.clientCalls)throw new ApiError(503,'Client call authorization is required');
   context.signal.throwIfAborted();const owner=AbortSignal.any([network.connectionSignal(client.id),this.#owner.signal]);owner.throwIfAborted();
   const record:Registration={name,client:client.id,owner,remove:()=>{if(this.#records.get(name)!==record)return;this.#records.delete(name);owner.removeEventListener('abort',record.remove);record.release?.();}};
   this.#records.set(name,record);owner.addEventListener('abort',record.remove,{once:true});
   if(klippy?.remoteRegistrationReady){try{await this.#publish(record,klippy,context.signal);}catch(error){record.remove();throw error;}}
   return 'ok';
  });
 }
 #deliver(record:Registration,values:Readonly<Record<string,Json>>,lifetime:AbortSignal){
  this.#metrics.received++;
  const consume=(report:DeliveryReport)=>{for(const key of ['sent','denied','closed','overflow','failed'] as const)this.#metrics[key]+=report[key];};
  try{const result=this.#network.dispatchClientCall(record.client,record.name,values,lifetime);if('then' in result)void result.then(consume,()=>{this.#metrics.rejected++;});else consume(result);}catch{this.#metrics.rejected++;}
 }
 #publish(record:Registration,klippy:KlippyLifecycle,signal?:AbortSignal):Promise<void>{
  if(record.pending)return record.pending;
  if(record.runtime===klippy&&record.release)return Promise.resolve();
  record.release?.();record.release=undefined;record.runtime=klippy;record.error=undefined;
  const pending=klippy.registerLiveRemoteMethod(record.name,(values,lifetime)=>this.#deliver(record,values,lifetime),record.owner,{signal}).then(release=>{
   if(this.#records.get(record.name)!==record||record.owner.aborted){release();return;}record.release=release;
  }).catch(error=>{record.error=error instanceof Error?error.message:String(error);throw error;}).finally(()=>{if(record.pending===pending)record.pending=undefined;});
  record.pending=pending;return pending;
 }
 /** Drain before publishing initialized/ready. Rejections are observable per
  * registration, as upstream logs and continues for individual method errors. */
 async publishPending(klippy:KlippyLifecycle):Promise<void>{
  for(const record of this.#records.values()){
   klippy.signal.throwIfAborted();if(!klippy.remoteRegistrationReady)break;
   try{await this.#publish(record,klippy);}catch{klippy.signal.throwIfAborted();}
  }
 }
 /** Do not let an old registration completion overwrite a new generation. */
 async settleGeneration(klippy:KlippyLifecycle):Promise<void>{
  await Promise.allSettled([...this.#records.values()].filter(r=>r.runtime===klippy&&r.pending).map(r=>r.pending!));
 }
 get registrations(){return [...this.#records.values()].map(r=>({name:r.name,client:r.client,state:r.pending?'publishing':r.runtime?.signal.aborted?'pending':r.error?'failed':r.release?'registered':'pending',...(r.error?{error:r.error}:{})}));}
 get metrics(){return {...this.#metrics};}
 close(){this.#owner.abort();this.#release();}
}
