import {TrustedClients} from './trusted-clients.ts';
// Native API-key subset of pinned Moonraker authorization.py; GPL-3.0-or-later.
import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import type {IncomingMessage} from 'node:http';
import type {DatabaseStore} from './database.ts';
import type {DatabaseNamespace} from './database-namespace.ts';
import type {EndpointRegistry} from './endpoints.ts';
import type {NetworkAuthorization,MoonrakerNetworkOptions} from './server.ts';
import {LocalUserAuthorization,type LocalUserOptions,type UserChange,type UserCommitted} from './local-user-authorization.ts';
import {ApiError,type Json,type AuthorizedUser,type RpcContext} from './rpc.ts';
import {authorizationAddress,LoginAttempts,OneShotTokens} from './authorization-policy.ts';
import type {DeliveryReport} from './notifications.ts';
export interface AuthorizationEvents {broadcast(method:string,params:readonly Json[]):Promise<DeliveryReport>;}
export interface AuthorizationOptions extends LocalUserOptions {trustedClients?:readonly string[];maxLoginAttempts?:number;enableApiKey?:boolean;monotonicNow?:()=>number;}
interface UserSession {token:string;username:string;kid:string;}
type Principal=number|UserSession|'trusted';
const namespace='native_authorization',identity=Object.freeze({username:'_API_KEY_USER_'});
const digest=(key:string)=>createHash('sha256').update(key).digest();
/** One owner per DatabaseStore; credentials never enter the public namespace API.
 * Address admission requires explicit numeric trustedClients configuration. */
export class ApiKeyAuthorization {
 readonly #trusted:TrustedClients;
 readonly #database:DatabaseStore;readonly #store:DatabaseNamespace;
 readonly #connections=new WeakMap<IncomingMessage,Principal|null>();
 readonly #requests=new WeakMap<AbortSignal,IncomingMessage>();
 readonly #principals=new WeakMap<AbortSignal,Principal>();readonly #oneShotRequests=new WeakMap<IncomingMessage,Principal>();
 readonly #attempts:LoginAttempts;readonly #oneShots:OneShotTokens<Principal>;readonly #enableApiKey:boolean;
 get policyStatus(){return {login:this.#attempts.status,oneShotTokens:this.#oneShots.count};}
 #users?:LocalUserAuthorization;
 readonly #eventGrants=new Set<UserChange>();readonly #eventTasks=new Set<Promise<void>>();readonly #eventTickets=new Set<()=>void>();
 readonly #eventTotals={published:0,failed:0,closed:0,sent:0,denied:0,overflow:0};
 get eventStatus(){return {...this.#eventTotals,pending:this.#eventTickets.size};}

 #key:string;#digest:Buffer;#generation=0;#closed=false;#rotation:Promise<string>|undefined;
 private constructor(database:DatabaseStore,store:DatabaseNamespace,key:string,options?:AuthorizationOptions){this.#trusted=new TrustedClients(options?.trustedClients);this.#attempts=new LoginAttempts(options?.maxLoginAttempts);this.#oneShots=new OneShotTokens(options?.monotonicNow);this.#enableApiKey=options?.enableApiKey??true;this.#database=database;this.#store=store;this.#key=key;this.#digest=digest(key);}
 static async open(database:DatabaseStore,options?:AuthorizationOptions){
  if(options?.enableApiKey!==undefined&&typeof options.enableApiKey!=='boolean')throw new ApiError(400,'Invalid API key policy');new LoginAttempts(options?.maxLoginAttempts);new TrustedClients(options?.trustedClients);
  const store=await database.registerLocalNamespace(namespace,{forbidden:true,parseKeys:false});
  const saved=await store.get('api_key');let key:string;
  if(saved===null){key=randomBytes(16).toString('hex');await store.insert('api_key',key);}
  else{if(typeof saved!=='string'||!(/^[a-f0-9]{32}$/u.test(saved)))throw new ApiError(500,'Invalid persisted API key');key=saved;}
  const owner=new ApiKeyAuthorization(database,store,key,options);if(options)owner.#users=await LocalUserAuthorization.open(database,options);return owner;
 }
 #active(){const status=this.#database.status;if(this.#closed||status.closed||status.closing||status.restoreState!=='ready')throw new ApiError(503,'Authorization unavailable');}
 /** Local provisioning only. Never include this value in diagnostics or logs. */
 localApiKey(){this.#active();return this.#key;}
 #matches(value:unknown){return this.#enableApiKey&&typeof value==='string'&&/^[a-f0-9]{32}$/u.test(value)&&timingSafeEqual(digest(value),this.#digest);}
 authorize(method:string,params:Readonly<Record<string,Json>>,context:NetworkAuthorization):AuthorizedUser|undefined{
  this.#active();context.signal.throwIfAborted();
  this.#requests.set(context.signal,context.request);
  const remember=(principal:Principal)=>{this.#principals.set(context.signal,principal);if(context.transport==='websocket')this.#connections.set(context.request,principal);return typeof principal==='number'?identity:{username:principal==='trusted'?'_TRUSTED_USER_':principal.username};};
  const validate=(principal:Principal)=>{if(typeof principal==='number'){if(!this.#enableApiKey||principal!==this.#generation)throw new ApiError(401,'Invalid API Key');}else if(principal==='trusted'){if(!this.#trusts(context.request))throw new ApiError(401,'Trusted client authorization no longer available');}else this.#users!.decode(principal.token,'access',false);return remember(principal);};
  const identify=method==='server.connection.identify',session=this.#connections.get(context.request);
  const acceptToken=(token:unknown)=>{if(!this.#users)throw new ApiError(401,'Bearer authentication is not configured');const user=this.#users.decode(token,'access',!['access.login','access.refresh_jwt','access.info'].includes(method));if(context.transport==='websocket')this.#users.decode(token);return remember({token:token as string,username:user.username,kid:JSON.parse(Buffer.from((token as string).split('.')[0],'base64url').toString()).kid});};
  const acceptKey=(key:unknown)=>{if(!this.#matches(key))throw new ApiError(401,'Invalid API Key');return remember(this.#generation);};
  if(identify){try{if(params.access_token!==undefined)return acceptToken(params.access_token);if(params.api_key!==undefined)return acceptKey(params.api_key);}catch(error){if(context.transport==='websocket')this.#connections.set(context.request,null);throw error;}}
  // A successful WS login supersedes credentials from the upgrade request.
  if(context.transport==='websocket'&&session!==undefined){
   if(method==='access.login'||method==='access.refresh_jwt'||method==='access.info')return;
   if(session!==null)return validate(session);
   throw new ApiError(401,'Invalid API Key');
  }
  const authorization=context.request.headers.authorization;
  const query=authorization===undefined&&context.request.headers['x-access-token']===undefined&&context.request.url?.includes('access_token')?new URL(context.request.url, 'http://localhost').searchParams.getAll('access_token'):[];
  const token=authorization!==undefined?(authorization.startsWith('Bearer ')?authorization.slice(7):authorization):context.request.headers['x-access-token']??query.at(-1);
  if(token!==undefined)return acceptToken(token);
  const cached=this.#oneShotRequests.get(context.request);if(cached!==undefined)return validate(cached);
  if(context.request.url?.includes('token')){const oneShot=new URL(context.request.url,'http://localhost').searchParams.getAll('token').at(-1);if(oneShot!==undefined){const principal=this.#oneShots.consume(oneShot,authorizationAddress(context.request.socket.remoteAddress));if(principal!==undefined){const user=validate(principal);if(context.transport==='http')this.#oneShotRequests.set(context.request,principal);return user;}}}
  const header=context.request.headers['x-api-key'];if(header!==undefined)return acceptKey(header);
  if(this.#trusts(context.request))return remember('trusted');
  if(method==='access.info'||this.#users&&(method==='access.login'||method==='access.refresh_jwt'))return;
  throw new ApiError(401,'Unauthorized');
 }
 #trusts(request:IncomingMessage){
  if(this.#users?.forceLogins&&this.#users.count>0)return false;
  // Do not turn a trusted peer into a proxy delegation grant.
  if(['forwarded','x-forwarded-for','x-real-ip'].some(name=>request.headers[name]!==undefined))return false;
  return this.#trusted.matches(request.socket.remoteAddress);
 }
 readonly networkOptions:Pick<MoonrakerNetworkOptions,'authorize'|'authorizeNotification'|'authorizeSubscriptionConnection'>={
  authorize:(method,params,context)=>this.authorize(method,params,context),
  authorizeNotification:(method,params,context)=>{
   try{this.authorize('notification',{},context);}catch(error){
    // A committed revocation may deliver only its own terminal event to the
    // old session. This grant never authorizes RPCs or other notifications.
    if(!(error instanceof ApiError)||error.status!==401)throw error;
    const session=this.#connections.get(context.request),payload=params[0];
    if(session&&typeof session==='object'&&params.length===1&&payload&&typeof payload==='object'&&!Array.isArray(payload)&&Object.keys(payload).length===1&&payload.username===session.username){
     for(const event of this.#eventGrants)if(event.kind!=='user_created'&&method==='notify_'+event.kind&&event.username===session.username&&event.revokedKid===session.kid)return;
    }
    throw error;
   }
  },
  authorizeSubscriptionConnection:(source,target)=>{const from=this.authorize('subscription',{},source),to=this.authorize('subscription',{},target);if(!from||from.username!==to?.username)throw new ApiError(403,'Subscription identity mismatch');}
 };
 rotate():Promise<string>{
  this.#active();if(this.#rotation)throw new ApiError(409,'API key rotation in progress');
  const next=randomBytes(16).toString('hex');
  const work=(async()=>{try{await this.#store.insert('api_key',next);this.#key=next;this.#digest=digest(next);this.#generation++;return next;}catch(error){this.#closed=true;throw error;}})();
  this.#rotation=work;void work.finally(()=>{if(this.#rotation===work)this.#rotation=undefined;}).catch(()=>{});return work;
 }
 /** Reserve bounded event work before mutation, then publish only committed
  * changes after response handoff (also after a failed/disconnected handoff). */
 #mutation<T>(context:RpcContext,delivery:AuthorizationEvents|undefined,operation:(committed:UserCommitted)=>Promise<T>):Promise<T>{
  if(!delivery)return operation(()=>{});
  if(this.#eventTickets.size>=128)throw new ApiError(429,'Authorization event capacity exceeded');
  let change:UserChange|undefined,completed=!context.afterResponse,released=false,started=false;
  const release=()=>{if(released)return;released=true;this.#eventTickets.delete(release);};this.#eventTickets.add(release);
  const publish=()=>{
   if(!change||!completed||started||released)return;started=true;
   if(this.#closed){this.#eventTotals.closed++;release();return;}
   const event=change;this.#eventGrants.add(event);this.#eventTotals.published++;
   const task=(async()=>{try{const report=await delivery.broadcast('notify_'+event.kind,[{username:event.username}]);for(const name of ['sent','denied','closed','overflow','failed'] as const)this.#eventTotals[name]+=report[name];}catch{this.#eventTotals.failed++;}finally{this.#eventGrants.delete(event);release();}})();
   this.#eventTasks.add(task);void task.finally(()=>this.#eventTasks.delete(task));
  };
  try{context.afterResponse?.(()=>{completed=true;publish();});}catch(error){release();throw error;}
  try{return operation(event=>{change=event;publish();}).finally(()=>{if(!change)release();});}catch(error){release();throw error;}
 }
 register(endpoints:EndpointRegistry,delivery?:AuthorizationEvents):()=>void{
  const remove:Array<()=>void>=[];
  try{
   remove.push(endpoints.register({endpoint:'/access/api_key',methods:['GET','POST'],transports:['http','websocket']},async(_params,verb)=>{this.#active();return verb==='POST'?await this.rotate():this.localApiKey();}));
   remove.push(endpoints.register({endpoint:'/access/oneshot_token',methods:['GET'],transports:['http','websocket']},(_params,_verb,ctx)=>{
    this.#active();const request=this.#requests.get(ctx.signal),principal=this.#principals.get(ctx.signal);if(!request||principal===undefined)throw new ApiError(401,'Authenticated request context required');return this.#oneShots.issue(authorizationAddress(request.socket.remoteAddress),principal);
   }));
   // Trusted-network policy is not implicitly enabled.
   remove.push(endpoints.register({endpoint:'/access/info',methods:['GET'],transports:['http','websocket']},(_params,_verb,ctx)=>{this.#active();return {default_source:'moonraker',available_sources:this.#users?['moonraker']:[],login_required:!!this.#users?.forceLogins&&this.#users.count>0,trusted:this.#trusted.matches(this.#requests.get(ctx.signal)?.socket.remoteAddress)};}));
   const users=this.#users;
   if(users){
    const login=async(params:Readonly<Record<string,Json>>,ctx:RpcContext,create=false)=>{const operation=()=>this.#mutation(ctx,create?delivery:undefined,committed=>users.login(params,ctx.signal,create,committed));const result=await (create?operation():this.#attempts.run(this.#attempts.enabled?authorizationAddress(this.#requests.get(ctx.signal)?.socket.remoteAddress):'',ctx.signal,operation));this.#active();ctx.signal.throwIfAborted();const request=this.#requests.get(ctx.signal);if(request&&ctx.transport==='websocket'&&!create)this.#connections.set(request,{token:result.token,username:result.username,kid:JSON.parse(Buffer.from(result.token.split('.')[0],'base64url').toString()).kid});return result;};
    remove.push(endpoints.register({endpoint:'/access/login',methods:['POST'],transports:['http','websocket']},(params,_verb,ctx)=>login(params,ctx)));
    remove.push(endpoints.register({endpoint:'/access/refresh_jwt',methods:['POST'],transports:['http','websocket']},params=>users.refresh(params.refresh_token)));
    remove.push(endpoints.register({endpoint:'/access/logout',methods:['POST'],transports:['http','websocket']},(_params,_verb,ctx)=>this.#mutation(ctx,delivery,committed=>users.logout(ctx.user?.username??'',ctx.signal,committed))));
    remove.push(endpoints.register({endpoint:'/access/user',methods:['GET','POST','DELETE'],transports:['http','websocket']},(params,verb,ctx)=>{
     if(verb==='POST')return login(params,ctx,true);
     if(verb==='DELETE')return this.#mutation(ctx,delivery,committed=>users.delete(params.username,ctx.user?.username??'',ctx.signal,committed));
     return ctx.user&&ctx.user.username!==identity.username?users.user(ctx.user.username):{username:null,source:null,created_on:null};
    }));
    remove.push(endpoints.register({endpoint:'/access/users/list',methods:['GET'],transports:['http','websocket']},()=>users.list()));
    remove.push(endpoints.register({endpoint:'/access/user/password',methods:['POST'],transports:['http','websocket']},(params,_verb,ctx)=>users.password(ctx.user?.username??'',params,ctx.signal)));
   }
   return ()=>{for(const dispose of remove.reverse())dispose();};
  }catch(error){for(const dispose of remove.reverse())dispose();throw error;}
 }
 async close(){this.#closed=true;this.#attempts.close();this.#oneShots.close();await this.#rotation;await this.#users?.close();for(const release of this.#eventTickets)release();await Promise.all(this.#eventTasks);this.#eventGrants.clear();}
}
