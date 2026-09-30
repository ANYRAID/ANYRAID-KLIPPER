// Native API-key subset of pinned Moonraker authorization.py; GPL-3.0-or-later.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {NetworkAuthorization,MoonrakerNetworkOptions} from './server.ts';
import {LocalUserAuthorization,type LocalUserOptions} from './local-user-authorization.ts';
import {ApiError,type Json,type AuthorizedUser} from './rpc.ts';
const namespace='native_authorization',identity=Object.freeze({username:'_API_KEY_USER_'});
const digest=(key:string)=>createHash('sha256').update(key).digest();
/** One owner per DatabaseStore; credentials never enter the public namespace API.
 * No trust-by-address, test password, or implicit anonymous admission. */
export class ApiKeyAuthorization {
 readonly #database:DatabaseStore;readonly #store:DatabaseNamespace;
 readonly #connections=new WeakMap<IncomingMessage,number|string>();
 readonly #requests=new WeakMap<AbortSignal,IncomingMessage>();
 #users?:LocalUserAuthorization;
 #key:string;#digest:Buffer;#generation=0;#closed=false;#rotation:Promise<string>|undefined;
 private constructor(database:DatabaseStore,store:DatabaseNamespace,key:string){this.#database=database;this.#store=store;this.#key=key;this.#digest=digest(key);}
 static async open(database:DatabaseStore,options?:LocalUserOptions){
  const store=await database.registerLocalNamespace(namespace,{forbidden:true,parseKeys:false});
  const saved=await store.get('api_key');let key:string;
  if(saved===null){key=randomBytes(16).toString('hex');await store.insert('api_key',key);}
  else{if(typeof saved!=='string'||!(/^[a-f0-9]{32}$/u.test(saved)))throw new ApiError(500,'Invalid persisted API key');key=saved;}
  const owner=new ApiKeyAuthorization(database,store,key);if(options)owner.#users=await LocalUserAuthorization.open(database,options);return owner;
 }
 #active(){const status=this.#database.status;if(this.#closed||status.closed||status.closing||status.restoreState!=='ready')throw new ApiError(503,'Authorization unavailable');}
 /** Local provisioning only. Never include this value in diagnostics or logs. */
 localApiKey(){this.#active();return this.#key;}
 #matches(value:unknown){return typeof value==='string'&&/^[a-f0-9]{32}$/u.test(value)&&timingSafeEqual(digest(value),this.#digest);}
 authorize(method:string,params:Readonly<Record<string,Json>>,context:NetworkAuthorization):AuthorizedUser|undefined{
  this.#active();context.signal.throwIfAborted();
  if(context.transport==='websocket')this.#requests.set(context.signal,context.request);
  const identify=method==='server.connection.identify',session=this.#connections.get(context.request);
  const acceptToken=(token:unknown)=>{if(!this.#users)throw new ApiError(401,'Bearer authentication is not configured');const user=this.#users.decode(token,'access',!['access.login','access.refresh_jwt','access.info'].includes(method));if(context.transport==='websocket')this.#connections.set(context.request,token as string);return user;};
  const acceptKey=(key:unknown)=>{if(!this.#matches(key))throw new ApiError(401,'Invalid API Key');if(context.transport==='websocket')this.#connections.set(context.request,this.#generation);return identity;};
  if(identify&&params.access_token!==undefined)return acceptToken(params.access_token);
  if(identify&&params.api_key!==undefined)return acceptKey(params.api_key);
  // A successful WS login supersedes credentials from the upgrade request.
  if(context.transport==='websocket'&&session!==undefined){
   if(method==='access.login'||method==='access.refresh_jwt'||method==='access.info')return;
   if(typeof session==='string')return acceptToken(session);
   if(session===this.#generation)return identity;
   throw new ApiError(401,'Invalid API Key');
  }
  const authorization=context.request.headers.authorization;
  const query=authorization===undefined&&context.request.headers['x-access-token']===undefined&&context.request.url?.includes('access_token')?new URL(context.request.url, 'http://localhost').searchParams.getAll('access_token'):[];
  const token=authorization!==undefined?(authorization.startsWith('Bearer ')?authorization.slice(7):authorization):context.request.headers['x-access-token']??query.at(-1);
  if(token!==undefined)return acceptToken(token);
  const header=context.request.headers['x-api-key'];if(header!==undefined)return acceptKey(header);
  if(method==='access.info'||this.#users&&(method==='access.login'||method==='access.refresh_jwt'))return;
  throw new ApiError(401,'Unauthorized');
 }
 readonly networkOptions:Pick<MoonrakerNetworkOptions,'authorize'|'authorizeNotification'|'authorizeSubscriptionConnection'>={
  authorize:(method,params,context)=>this.authorize(method,params,context),
  authorizeNotification:(_method,_params,context)=>{this.authorize('notification',{},context);},
  authorizeSubscriptionConnection:(source,target)=>{const from=this.authorize('subscription',{},source),to=this.authorize('subscription',{},target);if(!from||from.username!==to?.username)throw new ApiError(403,'Subscription identity mismatch');}
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
   // Trusted-network policy is not implicitly enabled.
   remove.push(endpoints.register({endpoint:'/access/info',methods:['GET'],transports:['http','websocket']},()=>{this.#active();return {default_source:'moonraker',available_sources:this.#users?['moonraker']:[],login_required:!!this.#users?.forceLogins&&this.#users.count>0,trusted:false};}));
   const users=this.#users;
   if(users){
    const login=async(params:Readonly<Record<string,Json>>,signal:AbortSignal,create=false)=>{const result=await users.login(params,signal,create);this.#active();signal.throwIfAborted();const request=this.#requests.get(signal);if(request&&!create)this.#connections.set(request,result.token);return result;};
    remove.push(endpoints.register({endpoint:'/access/login',methods:['POST'],transports:['http','websocket']},(params,_verb,ctx)=>login(params,ctx.signal)));
    remove.push(endpoints.register({endpoint:'/access/refresh_jwt',methods:['POST'],transports:['http','websocket']},params=>users.refresh(params.refresh_token)));
    remove.push(endpoints.register({endpoint:'/access/logout',methods:['POST'],transports:['http','websocket']},(_params,_verb,ctx)=>users.logout(ctx.user?.username??'',ctx.signal)));
    remove.push(endpoints.register({endpoint:'/access/user',methods:['GET','POST','DELETE'],transports:['http','websocket']},(params,verb,ctx)=>{
     if(verb==='POST')return login(params,ctx.signal,true);
     if(verb==='DELETE')return users.delete(params.username,ctx.user?.username??'',ctx.signal);
     return ctx.user&&ctx.user.username!==identity.username?users.user(ctx.user.username):{username:null,source:null,created_on:null};
    }));
    remove.push(endpoints.register({endpoint:'/access/users/list',methods:['GET'],transports:['http','websocket']},()=>users.list()));
    remove.push(endpoints.register({endpoint:'/access/user/password',methods:['POST'],transports:['http','websocket']},(params,_verb,ctx)=>users.password(ctx.user?.username??'',params,ctx.signal)));
   }
   return ()=>{for(const dispose of remove.reverse())dispose();};
  }catch(error){for(const dispose of remove.reverse())dispose();throw error;}
 }
 async close(){this.#closed=true;await this.#rotation;await this.#users?.close();}
}
