// Native API-key subset of pinned Moonraker authorization.py; GPL-3.0-or-later.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {NetworkAuthorization,MoonrakerNetworkOptions} from './server.ts';
import {ApiError,type Json,type AuthorizedUser} from './rpc.ts';
const namespace='native_authorization',identity=Object.freeze({username:'_API_KEY_USER_'});
const digest=(key:string)=>createHash('sha256').update(key).digest();
/** One owner per DatabaseStore; credentials never enter the public namespace API.
 * No trust-by-address, test password, or implicit anonymous admission. */
export class ApiKeyAuthorization {
 readonly #database:DatabaseStore;readonly #store:DatabaseNamespace;
 readonly #connections=new WeakMap<IncomingMessage,number>();
 #key:string;#digest:Buffer;#generation=0;#closed=false;#rotation:Promise<string>|undefined;
 private constructor(database:DatabaseStore,store:DatabaseNamespace,key:string){this.#database=database;this.#store=store;this.#key=key;this.#digest=digest(key);}
 static async open(database:DatabaseStore){
  const store=await database.registerLocalNamespace(namespace,{forbidden:true,parseKeys:false});
  const saved=await store.get('api_key');let key:string;
  if(saved===null){key=randomBytes(16).toString('hex');await store.insert('api_key',key);}
  else{if(typeof saved!=='string'||!(/^[a-f0-9]{32}$/u.test(saved)))throw new ApiError(500,'Invalid persisted API key');key=saved;}
  return new ApiKeyAuthorization(database,store,key);
 }
 #active(){const status=this.#database.status;if(this.#closed||status.closed||status.closing||status.restoreState!=='ready')throw new ApiError(503,'Authorization unavailable');}
 /** Local provisioning only. Never include this value in diagnostics or logs. */
 localApiKey(){this.#active();return this.#key;}
 #matches(value:unknown){return typeof value==='string'&&/^[a-f0-9]{32}$/u.test(value)&&timingSafeEqual(digest(value),this.#digest);}
 authorize(method:string,params:Readonly<Record<string,Json>>,context:NetworkAuthorization):AuthorizedUser|undefined{
  this.#active();context.signal.throwIfAborted();
  // Do not accept a supplied unsupported bearer token by falling back to a key.
  if(context.request.headers.authorization!==undefined)throw new ApiError(401,'Bearer authentication is not yet configured');
  const header=context.request.headers['x-api-key'];
  const supplied=method==='server.connection.identify'&&params.api_key!==undefined?params.api_key:header;
  if(supplied!==undefined){if(!this.#matches(supplied))throw new ApiError(401,'Invalid API Key');if(context.transport==='websocket')this.#connections.set(context.request,this.#generation);return identity;}
  if(context.transport==='websocket'&&this.#connections.get(context.request)===this.#generation)return identity;
  if(method==='access.info')return;
  throw new ApiError(401,'Unauthorized');
 }
 readonly networkOptions:Pick<MoonrakerNetworkOptions,'authorize'|'authorizeNotification'|'authorizeSubscriptionConnection'>={
  authorize:(method,params,context)=>this.authorize(method,params,context),
  authorizeNotification:(_method,_params,context)=>{this.authorize('notification',{},context);},
  authorizeSubscriptionConnection:(source,target)=>{this.authorize('subscription',{},source);this.authorize('subscription',{},target);}
 };
 rotate():Promise<string>{
  this.#active();if(this.#rotation)throw new ApiError(409,'API key rotation in progress');
  const next=randomBytes(16).toString('hex');
  const work=(async()=>{try{await this.#store.insert('api_key',next);this.#key=next;this.#digest=digest(next);this.#generation++;return next;}catch(error){this.#closed=true;throw error;}})();
  this.#rotation=work;void work.finally(()=>{if(this.#rotation===work)this.#rotation=undefined;}).catch(()=>{});return work;
 }
 register(endpoints:EndpointRegistry):()=>void{
  const remove:Array<()=>void>=[];
  try{
   remove.push(endpoints.register({endpoint:'/access/api_key',methods:['GET','POST'],transports:['http','websocket']},async(_params,verb)=>{this.#active();return verb==='POST'?await this.rotate():this.localApiKey();}));
   // This initial owner has no user registry or trusted network policy.
   remove.push(endpoints.register({endpoint:'/access/info',methods:['GET'],transports:['http','websocket']},()=>{this.#active();return {default_source:'moonraker',available_sources:[],login_required:false,trusted:false};}));
   return ()=>{for(const dispose of remove.reverse())dispose();};
  }catch(error){for(const dispose of remove.reverse())dispose();throw error;}
 }
 async close(){this.#closed=true;await this.#rotation;}
}
