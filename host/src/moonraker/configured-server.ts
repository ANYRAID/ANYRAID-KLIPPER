import {KlippyLifecycle,type KlippyInitializationOptions,type KlippySnapshot} from './klippy-lifecycle.ts';
import {SubscriptionDelivery} from './subscription-delivery.ts';
import {KlippyNotifications} from './klippy-notifications.ts';
import {AgentMethods} from './agent-methods.ts';
import {KlippySupervisor} from './klippy-supervisor.ts';
import type {DeliveryReport} from './notifications.ts';
import {registerExtensions} from './extensions.ts';
import type {ClientArguments,ClientRequestOptions} from './client-requests.ts';
import type {AddressInfo} from 'node:net';
import {loadConfiguration,ConfigurationError,type ConfigurationLimits} from './config-source.ts';
import {ConfigurationReader} from './config-reader.ts';
import {JsonRpcDispatcher,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import {ServerInformation,ServerConfiguration,registerServerMetadata,type InformationSnapshot} from './metadata.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from './server.ts';
export interface NetworkBinding {readonly host:string;readonly port:number;readonly maxConnections:number;}
type KlippyAttachmentOptions=Omit<KlippyInitializationOptions,'version'|'onSnapshot'|'onRemoteMethodsReady'>;
const notificationMetrics=()=>({received:0,disabled:0,rejected:0,sent:0,denied:0,closed:0,overflow:0,failed:0});
export interface ConfiguredServerOptions extends Omit<MoonrakerNetworkOptions,'endpoints'|'maxConnections'> {
 /** Supplied by actual component/Klippy owners, never inferred from listening. */
 information:InformationSnapshot;
 configurationLimits?:ConfigurationLimits;
}
/** Pinned server.py host/port and application.py PrimaryRouter capacity defaults.
 * Port zero is valid for an ephemeral listener, as in Tornado/Node listen(). */
export function readNetworkBinding(reader:ConfigurationReader):NetworkBinding{
 const section=reader.section('server');
 const host=section.get('host',{defaultValue:'0.0.0.0'});
 if(!host||host.length>255||/[\s/\0]/u.test(host))throw new ConfigurationError('Invalid server host');
 const port=section.getInt('port',{defaultValue:7125,minval:0,maxval:65535});
 const maxConnections=section.getInt('max_websocket_connections',{defaultValue:50,minval:1,maxval:10000});
 return Object.freeze({host,port,maxConnections});
}
/** File-backed network composition, not the complete Moonraker daemon. Load
 * does not listen. Components consume config/register methods before start;
 * startup publishes their records and unused-option warnings together. */
export class ConfiguredMoonraker {
 readonly reader:ConfigurationReader;readonly binding:NetworkBinding;
 readonly rpc:JsonRpcDispatcher;readonly endpoints:EndpointRegistry;
 #network:MoonrakerNetwork;#information:ServerInformation;#configuration:ServerConfiguration;
 #subscriptions:SubscriptionDelivery|undefined;#klippy:KlippyLifecycle|undefined;#klippyRoutes=new Map<string,()=>void>();
 #base:InformationSnapshot;#release:()=>void;#opening:Promise<AddressInfo>|undefined;#stopping=false;
 #gcodeNotifications=notificationMetrics();#klippyNotifications=notificationMetrics();#klippyEvents=new KlippyNotifications();
 #agentMethods:AgentMethods;
 #reconnecting=false;#lastAttachment:{path:string;options:KlippyAttachmentOptions}|undefined;
 #supervisor:KlippySupervisor|undefined;
 private constructor(reader:ConfigurationReader,options:ConfiguredServerOptions){
  this.reader=reader;this.binding=readNetworkBinding(reader);
  this.#base=structuredClone(options.information);this.#information=new ServerInformation(this.#base);
  this.#configuration=new ServerConfiguration(reader.snapshot());this.rpc=new JsonRpcDispatcher();this.endpoints=new EndpointRegistry(this.rpc);
  this.#network=new MoonrakerNetwork(this.rpc,{...options,endpoints:this.endpoints,maxConnections:this.binding.maxConnections});
  const releaseMetadata=registerServerMetadata(this.endpoints,this.#information,this.#configuration,()=>this.#network.status.connections);
  const releaseExtensions=registerExtensions(this.endpoints,this.#network);
  this.#agentMethods=new AgentMethods(this.endpoints,this.#network,()=>this.#klippy);
  this.#release=()=>{this.#agentMethods.close();releaseExtensions();releaseMetadata();};
 }
 static async load(filename:string,options:ConfiguredServerOptions):Promise<ConfiguredMoonraker>{
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');
  return new ConfiguredMoonraker(new ConfigurationReader(await loadConfiguration(filename,options.configurationLimits)),options);
 }
 /** Explicitly attach one Klippy generation; no implicit device connection,
  * retry or replay is performed by HTTP server startup. */
 attachKlippy(path:string,options:KlippyAttachmentOptions={}):Promise<KlippySnapshot>{
  if(this.#supervisor)throw new Error('Klippy connection is owned by the supervisor');
  if(this.#reconnecting)throw new Error('Klippy recovery already in progress');
  return this.#attachKlippy(path,options);
 }
 #attachKlippy(path:string,options:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  if(this.#stopping||this.#klippy)throw new Error('Klippy generation already attached or server stopping');
  this.#lastAttachment={path,options:{...options,...options.remoteMethods?{remoteMethods:{...options.remoteMethods}}:{}}};
  let routedEndpoints:readonly string[]|undefined,routedInitialization=false;
  const runtime=new KlippyLifecycle({...options,onRemoteMethodsReady:()=>this.#agentMethods.publishPending(runtime),version:this.#base.version,onGcode:(response,signal)=>{this.#broadcastGcode(response);return options.onGcode?.(response,signal);},onSubscriptionStatus:(id,status,time)=>{this.#subscriptions?.deliver(id,status,time);options.onSubscriptionStatus?.(id,status,time);},onSnapshot:snapshot=>{
   if(!snapshot.connected)this.#subscriptions?.close();
   if(routedEndpoints!==snapshot.endpoints||routedInitialization!==snapshot.initialized){
   const exposed=new Set(snapshot.endpoints.filter(name=>!['list_endpoints','gcode/subscribe_output','register_remote_method','objects/subscribe'].includes(name))),added=new Map<string,()=>void>();
   if(snapshot.initialized&&snapshot.endpoints.includes('objects/subscribe'))exposed.add('objects/subscribe');
   try{for(const name of exposed)if(!this.#klippyRoutes.has(name))added.set(name,name==='objects/subscribe'?this.endpoints.register({endpoint:name,methods:['GET','POST'],remote:true,transports:['websocket','http']},(params,_verb,context)=>this.#subscriptions!.subscribe(params,context)):this.endpoints.register({endpoint:name,methods:['GET','POST'],remote:true},(params,_verb,context)=>runtime.request(name,{...params},{signal:context.signal})));}catch(error){for(const release of added.values())release();throw error;}
   for(const [name,release] of this.#klippyRoutes)if(!exposed.has(name)){release();this.#klippyRoutes.delete(name);}for(const [name,release] of added)this.#klippyRoutes.set(name,release);
   routedEndpoints=snapshot.endpoints;routedInitialization=snapshot.initialized;
   }
   if(!this.#stopping)this.setInformation({...this.#base,connected:snapshot.connected,state:snapshot.state,missingRequirements:snapshot.missingRequirements});
   for(const method of this.#klippyEvents.observe(snapshot))this.#broadcastTracked(method,[],this.#klippyNotifications);
  }});this.#klippy=runtime;this.#subscriptions=new SubscriptionDelivery({signal:id=>this.#network.connectionSignal(id),subscribe:(id,objects,signal)=>runtime.subscribe(id,objects,signal),remove:id=>runtime.removeSubscription(id),send:(id,status,time)=>this.#network.dispatchNotification(id,'notify_status_update',[status as Json,time]),disconnect:id=>this.#network.disconnectClient(id),enabled:()=>!!this.#network.status.notifications});return runtime.initialize(path);
 }
 /** Explicit recovery only after disconnection. Drain the old generation and
  * recreate protocol state; never replay G-code or an uncertain old request. */
 reconnectKlippy(path?:string,options?:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  if(this.#supervisor)return Promise.reject(new Error('Klippy connection is owned by the supervisor'));
  return this.#reconnectKlippy(path,options);
 }
 async #reconnectKlippy(path?:string,options?:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  const previous=this.#klippy,attachment=this.#lastAttachment;
  if(this.#stopping||this.#reconnecting||!previous||!attachment||!previous.signal.aborted)throw new Error('Klippy recovery requires a disconnected, attached generation');
  this.#reconnecting=true;
  try{
   await previous.close();await this.#agentMethods.settleGeneration(previous);
   if(this.#stopping)throw new Error('Configured server is stopping');
   if(this.#klippy!==previous)throw new Error('Klippy generation changed during recovery');
   this.#klippy=undefined;
   return await this.#attachKlippy(path??attachment.path,options??attachment.options);
  }finally{this.#reconnecting=false;}
 }
 /** Explicit opt-in to daemon-style connection ownership; network start alone
  * still does not initiate a printer connection. */
 superviseKlippy(path:string,options:KlippyAttachmentOptions={},retryDelayMs=250):void{
  if(this.#stopping||this.#klippy||this.#supervisor||this.#reconnecting)throw new Error('Klippy connection already owned or server stopping');
  const supervisor=new KlippySupervisor(async()=>{if(this.#klippy)await this.#reconnectKlippy();else await this.#attachKlippy(path,options);return this.#klippy!.signal;},()=>this.#klippy?.close()??Promise.resolve(),retryDelayMs);
  this.#supervisor=supervisor;supervisor.start();
 }
 get klippySupervisor(){return this.#supervisor?.status??null;}
 get cachedKlippyStatus(){return this.#klippy?.cachedStatus??null;}
 get gcodeNotifications(){return {...this.#gcodeNotifications};}
 get klippyNotifications(){return {...this.#klippyNotifications};}
 #broadcastGcode(response:string):void{
  this.#broadcastTracked('notify_gcode_response',[response],this.#gcodeNotifications);
 }
 #broadcastTracked(method:string,params:readonly Json[],metrics:ReturnType<typeof notificationMetrics>):void{
  metrics.received++;if(this.#stopping||this.#network.status.phase!=='listening'||!this.#network.status.notifications){metrics.disabled++;return;}
  const consume=(report:DeliveryReport)=>{for(const key of ['sent','denied','closed','overflow','failed'] as const)metrics[key]+=report[key];};
  // Client output cannot hold the Klippy callback lane or stop a print.
  // The network owns bounded authorization/output work and waits for it on close.
  try{const result=this.#network.dispatchBroadcast(method,params);if('then' in result)void result.then(consume,()=>{metrics.rejected++;});else consume(result);}catch{metrics.rejected++;}
 }
 get klippy(){return this.#klippy?.snapshot??null;}
 get klippyRemoteMethodFailures(){return this.#klippy?.remoteMethodFailures??[];}
 get klippyRemoteMethods(){return this.#klippy?.remoteMethods??null;}
 get agentRemoteMethods(){return this.#agentMethods.registrations;}
 get agentMethodDeliveries(){return this.#agentMethods.metrics;}
 get clients(){return this.#network.clients;}
 getClient(id:number){return this.#network.getClient(id);}
 getClientsByName(name:string){return this.#network.getClientsByName(name);}
 getClientsByType(type:string){return this.#network.getClientsByType(type);}
 getUnidentifiedClients(){return this.#network.getUnidentifiedClients();}
 getAgents(){return this.#network.getAgents();}
 getAgent(name:string){return this.#network.getAgent(name);}
 get status(){return this.#network.status;}
 /** Lifecycle owners may replace real state; serving HTTP never implies Klippy ready. */
 setInformation(snapshot:InformationSnapshot):void{
  if(this.#stopping)throw new Error('Configured server is stopping');
  const current=this.#klippy?.snapshot,copy=structuredClone(current?{...snapshot,connected:current.connected,state:current.state,missingRequirements:current.missingRequirements}:snapshot);this.#information.replace({...copy,warnings:[...new Set([...copy.warnings,...this.reader.warnings(),...this.klippyRemoteMethodFailures.map(f=>`Klippy remote method registration failed: ${f.name}`)])]});this.#base=copy;
 }
 start():Promise<AddressInfo>{
  if(this.#stopping)return Promise.reject(new Error('Configured server is stopping'));
  if(this.#opening)return this.#opening;
  this.#opening=this.#start();return this.#opening;
 }
 async #start():Promise<AddressInfo>{
  try{
   this.reader.validate();this.reader.publish(this.#configuration);this.setInformation(this.#base);
   return await this.#network.listen(this.binding.port,this.binding.host);
  }catch(error){try{await this.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Configured server startup and cleanup failed');}throw error;}
 }
 notify(connectionId:number,method:string,params:readonly Json[]):boolean{return this.#network.notify(connectionId,method,params);}
 notifyAuthorized(connectionId:number,method:string,params:readonly Json[]){return this.#network.notifyAuthorized(connectionId,method,params);}
 connectionSignal(connectionId:number){return this.#network.connectionSignal(connectionId);}
 requestClient(id:number,method:string,params:ClientArguments=null,options:ClientRequestOptions={}){return this.#network.requestClient(id,method,params,options);}
 broadcast(method:string,params:readonly Json[],excluded:readonly number[]=[]){return this.#network.broadcast(method,params,excluded);}
 async close():Promise<void>{
  this.#stopping=true;this.#subscriptions?.close();await Promise.all([this.#supervisor?.stop(),this.#network.close(),this.#klippy?.close()]);for(const release of this.#klippyRoutes.values())release();this.#klippyRoutes.clear();this.#release();
 }
}
