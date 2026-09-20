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
 #base:InformationSnapshot;#release:()=>void;#opening:Promise<AddressInfo>|undefined;#stopping=false;
 private constructor(reader:ConfigurationReader,options:ConfiguredServerOptions){
  this.reader=reader;this.binding=readNetworkBinding(reader);
  this.#base=structuredClone(options.information);this.#information=new ServerInformation(this.#base);
  this.#configuration=new ServerConfiguration(reader.snapshot());this.rpc=new JsonRpcDispatcher();this.endpoints=new EndpointRegistry(this.rpc);
  this.#network=new MoonrakerNetwork(this.rpc,{...options,endpoints:this.endpoints,maxConnections:this.binding.maxConnections});
  this.#release=registerServerMetadata(this.endpoints,this.#information,this.#configuration,()=>this.#network.status.connections);
 }
 static async load(filename:string,options:ConfiguredServerOptions):Promise<ConfiguredMoonraker>{
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');
  return new ConfiguredMoonraker(new ConfigurationReader(await loadConfiguration(filename,options.configurationLimits)),options);
 }
 get status(){return this.#network.status;}
 /** Lifecycle owners may replace real state; serving HTTP never implies Klippy ready. */
 setInformation(snapshot:InformationSnapshot):void{
  if(this.#stopping)throw new Error('Configured server is stopping');
  const copy=structuredClone(snapshot);this.#information.replace({...copy,warnings:[...new Set([...copy.warnings,...this.reader.warnings()])]});this.#base=copy;
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
 async close():Promise<void>{
  this.#stopping=true;await this.#network.close();this.#release();
 }
}
