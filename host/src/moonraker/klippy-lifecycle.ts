import {JobState,type JobChange} from './job-state.ts';
import {KlippyStatusCache,adoptStatus,type StatusCacheLimits,type StatusView} from './subscription-status.ts';
import {SubscriptionManager} from './subscription-manager.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {KlippySocket,type KlippySocketLimits,type KlippyRequestOptions,type KlippyMethod} from './klippy-socket.ts';
import {ApiError,type Json} from './rpc.ts';
import type {KlippyState} from './metadata.ts';
export interface KlippySnapshot {readonly connected:boolean;readonly identified:boolean;readonly initialized:boolean;readonly state:KlippyState;readonly stateMessage:string;readonly info:Readonly<Record<string,Json>>;readonly endpoints:readonly string[];readonly requirementsChecked:boolean;readonly missingRequirements:readonly string[];}
export interface KlippyInitializationOptions {version:string;trackJobState?:boolean;onJobChange?(change:JobChange):void;onRemoteMethodsReady?():Promise<void>;remoteMethods?:Readonly<Record<string,KlippyMethod>>;statusCacheLimits?:StatusCacheLimits;socketLimits?:KlippySocketLimits;pollIntervalMs?:number;startupTimeoutMs?:number;onSubscriptionStatus?(client:number,status:StatusView,eventtime:number):void;onSnapshot?(state:KlippySnapshot):void;onStatus?(status:Readonly<Record<string,Json>>,eventtime:number,signal:AbortSignal):void|Promise<void>;onGcodeCommand?(script:string):void;onGcode?(response:string,signal:AbortSignal):void|Promise<void>;}
function bound(v:number|undefined,fallback:number,max:number){const n=v??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'Invalid Klippy initialization limit');return n;}
const object=(v:unknown):v is Record<string,Json>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function freeze<T>(v:T):T{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function state(value:unknown):KlippyState{if(typeof value!=='string'||!['startup','ready','error','shutdown'].includes(value.toLowerCase()))throw new ApiError(502,'Invalid Klippy state');return value.toLowerCase() as KlippyState;}
function message(value:unknown):string{if(typeof value!=='string'||value.length>65536)throw new ApiError(502,'Invalid Klippy state message');return value;}
function strings(value:unknown,name:string):string[]{if(!Array.isArray(value)||value.length>4096||value.some(v=>typeof v!=='string'||!v||v.length>256))throw new ApiError(502,`Invalid Klippy ${name}`);return [...new Set(value as string[])];}
/** One initialization generation. Live webhooks revisions take precedence over
 * older in-flight info/subscription replies. This is not a reconnect supervisor. */
export class KlippyLifecycle {
 #jobs:JobState|undefined;#jobsReady=false;
 get jobState(){return this.#jobs?{stats:this.#jobs.lastStats,event:this.#jobs.lastEvent}:undefined;}
 #jobUpdate(status:Readonly<Record<string,Json>>){if(this.#jobsReady&&Object.hasOwn(status,"print_stats"))for(const change of this.#jobs!.update(status.print_stats))this.#options.onJobChange?.(change);}
 #subscriptions:SubscriptionManager;#cache:KlippyStatusCache;#socket:KlippySocket;#options:KlippyInitializationOptions;#poll:number;#timeout:number;#revision=0;#observerError:Error|undefined;#starting:Promise<KlippySnapshot>|undefined;
 #snapshot:KlippySnapshot=freeze({connected:false,identified:false,initialized:false,state:'disconnected',stateMessage:'',info:{},endpoints:[],requirementsChecked:false,missingRequirements:[]});
 // A per-generation capability: later shutdown/error does not revoke it.
 #remoteMethodsEnabled=false;
 #remoteMethodFailures=new Map<string,{status:number;message:string}>();
 #remoteMethods=new Map<string,()=>void>();#registeredRemoteMethods=new Set<string>();#nextRemoteGeneration=1;
 constructor(options:KlippyInitializationOptions,jobState?:JobState){if(typeof options.version!=='string'||!options.version||options.version.length>1024)throw new ApiError(400,'Invalid Moonraker version');if(options.trackJobState!==undefined&&typeof options.trackJobState!=='boolean'||options.onJobChange!==undefined&&typeof options.onJobChange!=='function')throw new ApiError(400,'Invalid job state configuration');this.#options={...options};if(options.trackJobState)this.#jobs=jobState??new JobState();this.#cache=new KlippyStatusCache(options.statusCacheLimits);this.#poll=bound(options.pollIntervalMs,250,60000);this.#timeout=bound(options.startupTimeoutMs,300000,2147483647);this.#socket=new KlippySocket(options.socketLimits);
  this.#subscriptions=new SubscriptionManager({cache:this.#cache,base:{webhooks:null,...this.#jobs?{print_stats:null}:{}},onSnapshotDifference:status=>{try{this.#jobUpdate(status);if(Object.hasOwn(status,"webhooks"))this.#webhooks(status.webhooks);}catch(error){void this.#socket.close().catch(()=>{});throw error;}},request:(objects,signal)=>this.#socket.request('objects/subscribe',{objects:objects as Json,response_template:{method:'process_status_update'}},{signal,timeoutMs:20000}),deliver:(client,status,eventtime)=>this.#options.onSubscriptionStatus?.(client,status,eventtime)});
  this.#socket.registerMethod('process_status_update',(p,signal)=>this.#status(p,signal));this.#socket.registerMethod('process_gcode_response',(p,signal)=>{if(typeof p.response!=='string')throw new ApiError(502,'Invalid GCode response');return this.#options.onGcode?.(p.response,signal);});
  this.#socket.signal.addEventListener('abort',()=>{this.#jobs?.disconnect();this.#jobsReady=false;this.#remoteMethodsEnabled=false;this.#remoteMethodFailures.clear();this.#registeredRemoteMethods.clear();void this.#subscriptions.close();this.#cache.clear();this.#revision++;this.#publish({connected:false,initialized:false,state:'disconnected',endpoints:[]});},{once:true});
  if(options.remoteMethods!==undefined){if(!options.remoteMethods||typeof options.remoteMethods!=='object'||Array.isArray(options.remoteMethods)||![Object.prototype,null].includes(Object.getPrototypeOf(options.remoteMethods)))throw new ApiError(400,'Invalid remote method configuration');for(const [name,handler] of Object.entries(options.remoteMethods))this.registerRemoteMethod(name,handler);}
 }
 /** Static component registration only. Releasing removes local ownership;
  * Klippy has no unregister request, so later peer callbacks are ignored. */
 registerRemoteMethod(name:string,handler:KlippyMethod):()=>void{
  if(this.#starting||this.signal.aborted)throw new ApiError(409,'Remote methods must be configured before initialization');
  return this.#installRemoteMethod(name,handler,name);
 }
 #installRemoteMethod(name:string,handler:KlippyMethod,callbackName:string):()=>void{
  if(typeof name!=='string'||!name||name.length>256||name.includes('\0')||name.startsWith('__mr_')||['process_status_update','process_gcode_response'].includes(name)||typeof handler!=='function'||this.#remoteMethods.has(name))throw new ApiError(400,'Invalid or duplicate remote method');
  if(this.#remoteMethods.size>=256)throw new ApiError(429,'Remote method capacity exceeded');const remove=this.#socket.registerMethod(callbackName,handler);let active=true;const release=()=>{if(!active)return;active=false;if(this.#remoteMethods.get(name)===release){this.#remoteMethods.delete(name);this.#remoteMethodFailures.delete(name);this.#registeredRemoteMethods.delete(name);}remove();};this.#remoteMethods.set(name,release);return release;
 }
 /** Live generation-scoped registration. A unique wire callback name prevents
  * late messages for an old owner from reaching a replacement of the same name. */
 async registerLiveRemoteMethod(name:string,handler:KlippyMethod,owner:AbortSignal,options:KlippyRequestOptions={}):Promise<()=>void>{
  if(!this.remoteRegistrationReady)throw new ApiError(503,'Klippy remote registration unavailable');
  if(typeof handler!=='function')throw new ApiError(400,'Invalid remote method handler');owner.throwIfAborted();options.signal?.throwIfAborted();
  if(!Number.isSafeInteger(this.#nextRemoteGeneration))throw new ApiError(429,'Remote generation exhausted');const callbackName='__mr_'+(this.#nextRemoteGeneration++).toString(36),controller=new AbortController(),lifetime=AbortSignal.any([owner,this.signal,controller.signal]);
  const remove=this.#installRemoteMethod(name,(params)=>{if(lifetime.aborted)return;try{const task=handler(params,lifetime);if(task&&typeof task.then==='function')return Promise.resolve(task).catch(error=>{if(!lifetime.aborted)throw error;});}catch(error){if(!lifetime.aborted)throw error;}},callbackName);
  let active=true;const release=()=>{if(!active)return;active=false;lifetime.removeEventListener('abort',release);remove();controller.abort(new ApiError(499,'Remote method owner released'));};lifetime.addEventListener('abort',release,{once:true});
  const signal=options.signal?AbortSignal.any([lifetime,options.signal]):lifetime;
  const cancelRegistration=()=>release();options.signal?.addEventListener('abort',cancelRegistration,{once:true});
  try{await this.#socket.request('register_remote_method',{remote_method:name,response_template:{method:callbackName}},{...options,timeoutMs:options.timeoutMs??20000,signal});signal.throwIfAborted();this.#registeredRemoteMethods.add(name);return release;}catch(error){release();throw error;}finally{options.signal?.removeEventListener('abort',cancelRegistration);}
 }
 get remoteRegistrationReady(){return this.#remoteMethodsEnabled&&this.#snapshot.connected&&this.#snapshot.state!=='disconnected'&&!this.signal.aborted;}
 get remoteMethodFailures(){return [...this.#remoteMethodFailures].map(([name,error])=>({name,...error}));}
 get remoteMethods(){return {configured:[...this.#remoteMethods.keys()],registered:[...this.#registeredRemoteMethods]};}
 get cachedStatus():StatusView{return this.#cache.read();}
 get cacheMetrics(){return this.#cache.metrics;}
 get snapshot():KlippySnapshot{return this.#snapshot;}
 get signal(){return this.#socket.signal;}
 get peerCredentials(){return this.#socket.peerCredentials;}
 get peerCredentialError(){return this.#socket.peerCredentialError;}
 get transportStatus(){return this.#socket.status;}
 #publish(changes:Partial<KlippySnapshot>){this.#snapshot=freeze({...this.#snapshot,...changes});try{this.#options.onSnapshot?.(this.#snapshot);}catch(error){this.#observerError??=new Error('Klippy state observer failed',{cause:error});void this.#socket.close().catch(()=>{});}}
 #webhooks(value:unknown){if(!object(value))throw new ApiError(502,'Invalid webhooks status');const changes:Partial<KlippySnapshot>={...(Object.hasOwn(value,'state')?{state:state(value.state)}:{}),...(Object.hasOwn(value,'state_message')?{stateMessage:message(value.state_message)}:{})};this.#revision++;if(changes.state!==undefined&&changes.state!==this.#snapshot.state||changes.stateMessage!==undefined&&changes.stateMessage!==this.#snapshot.stateMessage)this.#publish(changes);}
 #status(p:Record<string,Json>,signal:AbortSignal):void|Promise<void>{if(!object(p.status)||typeof p.eventtime!=='number'||!Number.isFinite(p.eventtime))throw new ApiError(502,'Invalid Klippy status update');const update=adoptStatus(p.status);this.#cache.apply(update);this.#jobUpdate(update);if(Object.hasOwn(update,'webhooks'))this.#webhooks(update.webhooks);signal.throwIfAborted();this.#subscriptions.publish(update,p.eventtime);return this.#options.onStatus?.(update,p.eventtime,signal);}
 initialize(path:string):Promise<KlippySnapshot>{if(this.#starting)return this.#starting;this.#starting=this.#initialize(path);return this.#starting;}
 async #initialize(path:string):Promise<KlippySnapshot>{
  const budget=new AbortController(),timer=setTimeout(()=>budget.abort(new ApiError(504,'Klippy initialization timed out')),this.#timeout),signal=AbortSignal.any([budget.signal,this.#socket.signal]);
  const stop=()=>{void this.#socket.close().catch(()=>{});};budget.signal.addEventListener('abort',stop,{once:true});
  const request=async(method:string,params:Record<string,Json>={})=>{signal.throwIfAborted();const value=await this.#socket.request(method,params,{signal});signal.throwIfAborted();return value;};
  const endpoints=async()=>{const result=await request('list_endpoints');if(!object(result))throw new ApiError(502,'Invalid Klippy endpoints');const values=strings(result.endpoints,'endpoints');if(values.some(v=>!/^\/?[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(v)||v.startsWith('/')))throw new ApiError(502,'Invalid Klippy endpoint name');this.#publish({endpoints:values});};
  try{
   await this.#socket.connect(path);signal.throwIfAborted();this.#publish({connected:true,state:'startup'});
   for(;;){const revision=this.#revision,first=!this.#snapshot.identified,info=await request('info',first?{client_info:{program:'Moonraker',version:this.#options.version}}:{});if(!object(info))throw new ApiError(502,'Invalid Klippy info');const current=state(info.state),text=info.state_message===undefined?this.#snapshot.stateMessage:message(info.state_message);this.#publish({identified:true,info:freeze(structuredClone(info)),...revision===this.#revision?{state:current,stateMessage:text}:{}});if(first)await endpoints();if(this.#snapshot.state!=='startup')break;await delay(this.#poll,undefined,{signal});}
   const revision=this.#revision,cacheRevision=this.#cache.revision,subscription=await request('objects/subscribe',{objects:{webhooks:null,...this.#jobs?{print_stats:null}:{}},response_template:{method:'process_status_update'}});if(!object(subscription)||!object(subscription.status)||typeof subscription.eventtime!=='number'||!Number.isFinite(subscription.eventtime))throw new ApiError(502,'Invalid initial Klippy subscription');this.#cache.replace(adoptStatus(subscription.status),cacheRevision);if(revision===this.#revision&&Object.hasOwn(subscription.status,'webhooks'))this.#webhooks(subscription.status.webhooks);
   if(this.#jobs&&this.#snapshot.state==='ready'){this.#jobs.initialize(this.#cache.read().print_stats??{});this.#jobsReady=true;}
   await request('gcode/subscribe_output',{response_template:{method:'process_gcode_response'}});await endpoints();
   const registerMethods=this.#snapshot.state==='ready';
   if(registerMethods){const objects=await request('objects/list');if(!object(objects))throw new ApiError(502,'Invalid Klippy object list');const available=new Set(strings(objects.objects,'object list'));this.#publish({requirementsChecked:true,missingRequirements:['virtual_sdcard','display_status','pause_resume'].filter(v=>!available.has(v))});}
   if(registerMethods)for(const [name,owner] of this.#remoteMethods){
    try{await request('register_remote_method',{response_template:{method:name},remote_method:name});if(this.#remoteMethods.get(name)===owner)this.#registeredRemoteMethods.add(name);}
    catch(error){signal.throwIfAborted();if(!(error instanceof ApiError))throw error;if(this.#remoteMethods.get(name)===owner)this.#remoteMethodFailures.set(name,{status:error.status,message:error.message.slice(0,4096)});}
   }
   if(registerMethods){this.#remoteMethodsEnabled=true;await this.#options.onRemoteMethodsReady?.();signal.throwIfAborted();}
   signal.throwIfAborted();this.#publish({initialized:true});signal.throwIfAborted();return this.#snapshot;
  }catch(error){try{await this.#socket.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Klippy initialization and cleanup failed');}throw this.#observerError??(budget.signal.aborted?budget.signal.reason:error);}
  finally{clearTimeout(timer);budget.signal.removeEventListener('abort',stop);}
 }
 request(method:string,params:Record<string,Json>={},options:KlippyRequestOptions={}){if(method==='gcode/script'&&typeof params.script==='string'&&this.#socket.status.phase==='connected'&&!options.signal?.aborted)this.#options.onGcodeCommand?.(params.script);return this.#socket.request(method,params,options);}
 subscribe(client:number,objects:unknown,signal?:AbortSignal){if(!this.#snapshot.initialized||this.signal.aborted)return Promise.reject(new ApiError(503,'Klippy subscriptions unavailable'));if(!this.#options.onSubscriptionStatus)return Promise.reject(new ApiError(503,'Subscription delivery owner required'));return this.#subscriptions.subscribe(client,objects,signal);}
 removeSubscription(client:number){this.#subscriptions.remove(client);}
 async close(){const subscriptions=this.#subscriptions.close();await this.#socket.close();await subscriptions;await this.#starting?.catch(()=>{});}
}
