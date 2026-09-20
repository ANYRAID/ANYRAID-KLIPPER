import {KlippyLifecycle,type KlippyInitializationOptions,type KlippySnapshot} from './klippy-lifecycle.ts';
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
 #klippy:KlippyLifecycle|undefined;#klippyRoutes=new Map<string,()=>void>();
 #base:InformationSnapshot;#release:()=>void;#opening:Promise<AddressInfo>|undefined;#stopping=false;
 private constructor(reader:ConfigurationReader,options:ConfiguredServerOptions){
  this.reader=reader;this.binding=readNetworkBinding(reader);
  this.#base=structuredClone(options.information);this.#information=new ServerInformation(this.#base);
  this.#configuration=new ServerConfiguration(reader.snapshot());this.rpc=new JsonRpcDispatcher();this.endpoints=new EndpointRegistry(this.rpc);
  this.#network=new MoonrakerNetwork(this.rpc,{...options,endpoints:this.endpoints,maxConnections:this.binding.maxConnections});
  const releaseMetadata=registerServerMetadata(this.endpoints,this.#information,this.#configuration,()=>this.#network.status.connections);
  const releaseExtensions=registerExtensions(this.endpoints,this.#network);
  this.#release=()=>{releaseExtensions();releaseMetadata();};
 }
 static async load(filename:string,options:ConfiguredServerOptions):Promise<ConfiguredMoonraker>{
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');
  return new ConfiguredMoonraker(new ConfigurationReader(await loadConfiguration(filename,options.configurationLimits)),options);
 }
 /** Explicitly attach one Klippy generation; no implicit device connection,
  * retry or replay is performed by HTTP server startup. */
 attachKlippy(path:string,options:Omit<KlippyInitializationOptions,'version'|'onSnapshot'>={}):Promise<KlippySnapshot>{
  if(this.#stopping||this.#klippy)throw new Error('Klippy generation already attached or server stopping');
  const runtime=new KlippyLifecycle({...options,version:this.#base.version,onSnapshot:snapshot=>{
   const exposed=new Set(snapshot.endpoints.filter(name=>!['list_endpoints','gcode/subscribe_output','register_remote_method','objects/subscribe'].includes(name))),added=new Map<string,()=>void>();
   try{for(const name of exposed)if(!this.#klippyRoutes.has(name))added.set(name,this.endpoints.register({endpoint:name,methods:['GET','POST'],remote:true},(params,_verb,context)=>runtime.request(name,{...params},{signal:context.signal})));}catch(error){for(const release of added.values())release();throw error;}
   for(const [name,release] of this.#klippyRoutes)if(!exposed.has(name)){release();this.#klippyRoutes.delete(name);}for(const [name,release] of added)this.#klippyRoutes.set(name,release);
   if(!this.#stopping)this.setInformation({...this.#base,connected:snapshot.connected,state:snapshot.state,missingRequirements:snapshot.missingRequirements});
  }});this.#klippy=runtime;return runtime.initialize(path);
 }
 get cachedKlippyStatus(){return this.#klippy?.cachedStatus??null;}
 get klippy(){return this.#klippy?.snapshot??null;}
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
  const current=this.#klippy?.snapshot,copy=structuredClone(current?{...snapshot,connected:current.connected,state:current.state,missingRequirements:current.missingRequirements}:snapshot);this.#information.replace({...copy,warnings:[...new Set([...copy.warnings,...this.reader.warnings()])]});this.#base=copy;
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
  this.#stopping=true;await Promise.all([this.#network.close(),this.#klippy?.close()]);for(const release of this.#klippyRoutes.values())release();this.#klippyRoutes.clear();this.#release();
 }
}
