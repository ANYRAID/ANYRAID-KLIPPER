import {KlippyStatusCache,adoptStatus,type StatusCacheLimits,type StatusView} from './subscription-status.ts';
import {SubscriptionManager} from './subscription-manager.ts';
import {setTimeout as delay} from 'node:timers/promises';
import {KlippySocket,type KlippySocketLimits,type KlippyRequestOptions} from './klippy-socket.ts';
import {ApiError,type Json} from './rpc.ts';
import type {KlippyState} from './metadata.ts';
export interface KlippySnapshot {readonly connected:boolean;readonly identified:boolean;readonly initialized:boolean;readonly state:KlippyState;readonly stateMessage:string;readonly info:Readonly<Record<string,Json>>;readonly endpoints:readonly string[];readonly requirementsChecked:boolean;readonly missingRequirements:readonly string[];}
export interface KlippyInitializationOptions {version:string;statusCacheLimits?:StatusCacheLimits;socketLimits?:KlippySocketLimits;pollIntervalMs?:number;startupTimeoutMs?:number;onSubscriptionStatus?(client:number,status:StatusView,eventtime:number):void;onSnapshot?(state:KlippySnapshot):void;onStatus?(status:Readonly<Record<string,Json>>,eventtime:number,signal:AbortSignal):void|Promise<void>;onGcode?(response:string,signal:AbortSignal):void|Promise<void>;}
function bound(v:number|undefined,fallback:number,max:number){const n=v??fallback;if(!Number.isSafeInteger(n)||n<1||n>max)throw new ApiError(400,'Invalid Klippy initialization limit');return n;}
const object=(v:unknown):v is Record<string,Json>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function freeze<T>(v:T):T{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
function state(value:unknown):KlippyState{if(typeof value!=='string'||!['startup','ready','error','shutdown'].includes(value.toLowerCase()))throw new ApiError(502,'Invalid Klippy state');return value.toLowerCase() as KlippyState;}
function message(value:unknown):string{if(typeof value!=='string'||value.length>65536)throw new ApiError(502,'Invalid Klippy state message');return value;}
function strings(value:unknown,name:string):string[]{if(!Array.isArray(value)||value.length>4096||value.some(v=>typeof v!=='string'||!v||v.length>256))throw new ApiError(502,`Invalid Klippy ${name}`);return [...new Set(value as string[])];}
/** One initialization generation. Live webhooks revisions take precedence over
 * older in-flight info/subscription replies. This is not a reconnect supervisor. */
export class KlippyLifecycle {
 #subscriptions:SubscriptionManager;#cache:KlippyStatusCache;#socket:KlippySocket;#options:KlippyInitializationOptions;#poll:number;#timeout:number;#revision=0;#observerError:Error|undefined;#starting:Promise<KlippySnapshot>|undefined;
 #snapshot:KlippySnapshot=freeze({connected:false,identified:false,initialized:false,state:'disconnected',stateMessage:'',info:{},endpoints:[],requirementsChecked:false,missingRequirements:[]});
 constructor(options:KlippyInitializationOptions){if(typeof options.version!=='string'||!options.version||options.version.length>1024)throw new ApiError(400,'Invalid Moonraker version');this.#options={...options};this.#cache=new KlippyStatusCache(options.statusCacheLimits);this.#poll=bound(options.pollIntervalMs,250,60000);this.#timeout=bound(options.startupTimeoutMs,300000,2147483647);this.#socket=new KlippySocket(options.socketLimits);
  this.#subscriptions=new SubscriptionManager({cache:this.#cache,base:{webhooks:null},onSnapshotDifference:status=>{try{if(Object.hasOwn(status,"webhooks"))this.#webhooks(status.webhooks);}catch(error){void this.#socket.close().catch(()=>{});throw error;}},request:(objects,signal)=>this.#socket.request('objects/subscribe',{objects:objects as Json,response_template:{method:'process_status_update'}},{signal,timeoutMs:20000}),deliver:(client,status,eventtime)=>this.#options.onSubscriptionStatus?.(client,status,eventtime)});
  this.#socket.registerMethod('process_status_update',(p,signal)=>this.#status(p,signal));this.#socket.registerMethod('process_gcode_response',(p,signal)=>{if(typeof p.response!=='string')throw new ApiError(502,'Invalid GCode response');return this.#options.onGcode?.(p.response,signal);});
  this.#socket.signal.addEventListener('abort',()=>{void this.#subscriptions.close();this.#cache.clear();this.#revision++;this.#publish({connected:false,initialized:false,state:'disconnected',endpoints:[]});},{once:true});
 }
 get cachedStatus():StatusView{return this.#cache.read();}
 get cacheMetrics(){return this.#cache.metrics;}
 get snapshot():KlippySnapshot{return this.#snapshot;}
 get signal(){return this.#socket.signal;}
 get transportStatus(){return this.#socket.status;}
 #publish(changes:Partial<KlippySnapshot>){this.#snapshot=freeze({...this.#snapshot,...changes});try{this.#options.onSnapshot?.(this.#snapshot);}catch(error){this.#observerError??=new Error('Klippy state observer failed',{cause:error});void this.#socket.close().catch(()=>{});}}
 #webhooks(value:unknown){if(!object(value))throw new ApiError(502,'Invalid webhooks status');const changes:Partial<KlippySnapshot>={...(Object.hasOwn(value,'state')?{state:state(value.state)}:{}),...(Object.hasOwn(value,'state_message')?{stateMessage:message(value.state_message)}:{})};this.#revision++;if(changes.state!==undefined&&changes.state!==this.#snapshot.state||changes.stateMessage!==undefined&&changes.stateMessage!==this.#snapshot.stateMessage)this.#publish(changes);}
 #status(p:Record<string,Json>,signal:AbortSignal):void|Promise<void>{if(!object(p.status)||typeof p.eventtime!=='number'||!Number.isFinite(p.eventtime))throw new ApiError(502,'Invalid Klippy status update');const update=adoptStatus(p.status);this.#cache.apply(update);if(Object.hasOwn(update,'webhooks'))this.#webhooks(update.webhooks);signal.throwIfAborted();this.#subscriptions.publish(update,p.eventtime);return this.#options.onStatus?.(update,p.eventtime,signal);}
 initialize(path:string):Promise<KlippySnapshot>{if(this.#starting)return this.#starting;this.#starting=this.#initialize(path);return this.#starting;}
 async #initialize(path:string):Promise<KlippySnapshot>{
  const budget=new AbortController(),timer=setTimeout(()=>budget.abort(new ApiError(504,'Klippy initialization timed out')),this.#timeout),signal=AbortSignal.any([budget.signal,this.#socket.signal]);
  const stop=()=>{void this.#socket.close().catch(()=>{});};budget.signal.addEventListener('abort',stop,{once:true});
  const request=async(method:string,params:Record<string,Json>={})=>{signal.throwIfAborted();const value=await this.#socket.request(method,params,{signal});signal.throwIfAborted();return value;};
  const endpoints=async()=>{const result=await request('list_endpoints');if(!object(result))throw new ApiError(502,'Invalid Klippy endpoints');const values=strings(result.endpoints,'endpoints');if(values.some(v=>!/^\/?[A-Za-z0-9_]+(?:\/[A-Za-z0-9_]+)*$/.test(v)||v.startsWith('/')))throw new ApiError(502,'Invalid Klippy endpoint name');this.#publish({endpoints:values});};
  try{
   await this.#socket.connect(path);signal.throwIfAborted();this.#publish({connected:true,state:'startup'});
   for(;;){const revision=this.#revision,first=!this.#snapshot.identified,info=await request('info',first?{client_info:{program:'Moonraker',version:this.#options.version}}:{});if(!object(info))throw new ApiError(502,'Invalid Klippy info');const current=state(info.state),text=info.state_message===undefined?this.#snapshot.stateMessage:message(info.state_message);this.#publish({identified:true,info:freeze(structuredClone(info)),...revision===this.#revision?{state:current,stateMessage:text}:{}});if(first)await endpoints();if(this.#snapshot.state!=='startup')break;await delay(this.#poll,undefined,{signal});}
   const revision=this.#revision,cacheRevision=this.#cache.revision,subscription=await request('objects/subscribe',{objects:{webhooks:null},response_template:{method:'process_status_update'}});if(!object(subscription)||!object(subscription.status)||typeof subscription.eventtime!=='number'||!Number.isFinite(subscription.eventtime))throw new ApiError(502,'Invalid initial Klippy subscription');this.#cache.replace(adoptStatus(subscription.status),cacheRevision);if(revision===this.#revision&&Object.hasOwn(subscription.status,'webhooks'))this.#webhooks(subscription.status.webhooks);
   await request('gcode/subscribe_output',{response_template:{method:'process_gcode_response'}});await endpoints();
   if(this.#snapshot.state==='ready'){const objects=await request('objects/list');if(!object(objects))throw new ApiError(502,'Invalid Klippy object list');const available=new Set(strings(objects.objects,'object list'));this.#publish({requirementsChecked:true,missingRequirements:['virtual_sdcard','display_status','pause_resume'].filter(v=>!available.has(v))});}
   signal.throwIfAborted();this.#publish({initialized:true});signal.throwIfAborted();return this.#snapshot;
  }catch(error){try{await this.#socket.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Klippy initialization and cleanup failed');}throw this.#observerError??(budget.signal.aborted?budget.signal.reason:error);}
  finally{clearTimeout(timer);budget.signal.removeEventListener('abort',stop);}
 }
 request(method:string,params:Record<string,Json>={},options:KlippyRequestOptions={}){return this.#socket.request(method,params,options);}
 subscribe(client:number,objects:unknown,signal?:AbortSignal){if(!this.#snapshot.initialized||this.signal.aborted)return Promise.reject(new ApiError(503,'Klippy subscriptions unavailable'));if(!this.#options.onSubscriptionStatus)return Promise.reject(new ApiError(503,'Subscription delivery owner required'));return this.#subscriptions.subscribe(client,objects,signal);}
 removeSubscription(client:number){this.#subscriptions.remove(client);}
 async close(){const subscriptions=this.#subscriptions.close();await this.#socket.close();await subscriptions;await this.#starting?.catch(()=>{});}
}
