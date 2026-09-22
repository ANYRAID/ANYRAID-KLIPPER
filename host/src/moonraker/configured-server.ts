import {MqttStatusRuntime} from './mqtt-status-runtime.ts';
import {readMqttStatusOptions} from './mqtt-status.ts';
import type {StatusView} from './subscription-status.ts';
import {MqttSensors} from './mqtt-sensors.ts';
import {MqttMacroPublisher} from './mqtt-macros.ts';
import {registerMqttPublish,registerMqttSubscribe} from './mqtt-api.ts';
import {SensorStore,registerSensors} from './sensors.ts';
import {HistoryFileMetadata} from './history-file-metadata.ts';
import {PrintApi,registerPrintApi,type PrintApiOptions} from './print-api.ts';
import {HistoryRuntime,type HistoryRuntimeOptions} from './history-runtime.ts';
import {HistoryRepository} from './history-repository.ts';
import {registerHistory,type HistoryApiOptions} from './history-api.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {registerDatabaseMaintenance} from './database-maintenance.ts';
import {DatabaseStore,registerDatabase} from './database.ts';
import {TemperatureStore,registerTemperatureStore} from './temperature-store.ts';
import {TemperatureStoreRuntime} from './temperature-store-runtime.ts';
import {GcodeStore,registerGcodeStore} from './gcode-store.ts';
import {MetadataMonitor,type MetadataMonitorOptions} from './metadata-watch.ts';
import {MetadataFiles,registerFileMetascan} from './metadata-files.ts';
import {registerFileMetadata} from './file-metadata.ts';
import {JobState} from './job-state.ts';
import {readKlippyBinding,type KlippyPathContext} from './klippy-config.ts';
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
import {ApiError,JsonRpcDispatcher,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import {ServerInformation,ServerConfiguration,registerServerMetadata,type InformationSnapshot} from './metadata.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from './server.ts';
export interface NetworkBinding {readonly host:string;readonly port:number;readonly maxConnections:number;}
type KlippyAttachmentOptions=Omit<KlippyInitializationOptions,'version'|'onSnapshot'|'onRemoteMethodsReady'>;
const mqttSensorOwners=new WeakSet<MqttSensors>();
const sensorOwners=new WeakSet<SensorStore>();
const fileOwners=new WeakSet<MetadataFiles>();
const databaseOwners=new WeakSet<DatabaseStore>();
const notificationMetrics=()=>({received:0,disabled:0,rejected:0,sent:0,denied:0,closed:0,overflow:0,failed:0});
export interface ConfiguredServerOptions extends Omit<MoonrakerNetworkOptions,'endpoints'|'maxConnections'> {
 /** Supplied by actual component/Klippy owners, never inferred from listening. */
 information:InformationSnapshot;
 maintenanceGate?:MaintenanceGate;
 onPrintStartComplete?:PrintApiOptions['onStartComplete'];
 /** Enable the G-code portion of data_store; temperature sampling is separate. */
 gcodeStore?:{maxBytes?:number};
 /** Transfers telemetry store lifetime on successful load; samples once per second after listening. */
 sensors?:SensorStore;
 /** Transfers an unstarted MQTT source owned by the supplied sensor store. */
 sensorTransport?:MqttSensors;
 temperatureStore?:{maxSensors?:number;maxSlots?:number};
 /** Transfers database lifetime on successful load. */
 database?:DatabaseStore;
 /** Repository must be initialized on this database before loading the server. */
 history?:HistoryApiOptions&{metadata?:HistoryRuntimeOptions['metadata'];auxiliary?:HistoryRuntimeOptions['auxiliary']};
 /** Service owner must reopen all database-dependent components after restore. */
 onDatabaseRestore?:()=>void|Promise<void>;
 configurationLimits?:ConfigurationLimits;
 /** Transfers admission-layer lifetime on successful load. Restore selected
  * metadata before listening; close files on shutdown, but not its dependencies. */
 metadataFiles?:MetadataFiles;
 metadataMonitor?:MetadataMonitorOptions;
 /** Opt in to bounded source discovery and scanning before listening. */
 discoverMetadataOnStart?:boolean;
 /** Enables configuration-owned Klippy supervision when the network starts. */
 klippy?:{initialization?:KlippyAttachmentOptions;retryDelayMs?:number;pathContext?:KlippyPathContext};
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
 readonly maintenanceGate:MaintenanceGate;
 readonly reader:ConfigurationReader;readonly binding:NetworkBinding;
 readonly rpc:JsonRpcDispatcher;readonly endpoints:EndpointRegistry;
 #metadataMonitor:MetadataMonitor|undefined;
 #discoverMetadata=false;#metadataDiscovery:{restored:number;scanned:number;unavailable:number;unsupported:number}|null=null;
 #metadataFiles:MetadataFiles|undefined;#startupAbort=new AbortController();#metadataRecovery:{restored:number;unavailable:number}|null=null;
 #network:MoonrakerNetwork;#information:ServerInformation;#configuration:ServerConfiguration;
 #subscriptions:SubscriptionDelivery|undefined;#klippy:KlippyLifecycle|undefined;#klippyRoutes=new Map<string,()=>void>();
 #base:InformationSnapshot;#release:()=>void;#opening:Promise<AddressInfo>|undefined;#stopping=false;
 #gcodeNotifications=notificationMetrics();#klippyNotifications=notificationMetrics();#klippyEvents=new KlippyNotifications();
 #gcodeStore:GcodeStore|undefined;
 #temperatureStore:TemperatureStoreRuntime|undefined;
 #database:DatabaseStore|undefined;#historyRuntime:HistoryRuntime|undefined;#historyNotifications=notificationMetrics();
 #mqttStatus:MqttStatusRuntime|undefined;
 #mqttMacros:MqttMacroPublisher|undefined;
 #sensorTransport:MqttSensors|undefined;
 #sensors:SensorStore|undefined;#sensorTimer:ReturnType<typeof setInterval>|undefined;#sensorError:string|null=null;#sensorSamples=0;#sensorNotifications=notificationMetrics();
 #printApi:PrintApi;
 #databaseRestart={requested:false,error:null as string|null};
 #agentMethods:AgentMethods;#jobState:JobState|undefined;
 #reconnecting=false;#lastAttachment:{path:string;options:KlippyAttachmentOptions}|undefined;
 #supervisor:KlippySupervisor|undefined;
 #automatic:{path:string;retryDelayMs:number;initialization:KlippyAttachmentOptions}|undefined;
 private constructor(reader:ConfigurationReader,options:ConfiguredServerOptions,automatic?:{path:string;retryDelayMs:number;initialization:KlippyAttachmentOptions}){
  if(options.sensorTransport!==undefined&&(!(options.sensorTransport instanceof MqttSensors)||!options.sensors||!options.sensorTransport.owns(options.sensors)||options.sensorTransport.status.closed||options.sensorTransport.status.started||mqttSensorOwners.has(options.sensorTransport)))throw new ConfigurationError('Invalid or already owned sensor transport');
  if(options.sensors&&(sensorOwners.has(options.sensors)||options.sensors.status.closed))throw new ConfigurationError('Invalid or already owned sensor store');
  if(options.history?.auxiliary&&options.history.auxiliaryTotals)throw new ConfigurationError('History auxiliary source must own its reset fields');
  if(options.database&&(databaseOwners.has(options.database)||options.database.status.closed||options.database.status.closing))throw new ConfigurationError('Invalid or already owned database');
  if(options.metadataFiles&&fileOwners.has(options.metadataFiles))throw new ConfigurationError('Metadata files already have a server owner');
  this.maintenanceGate=options.maintenanceGate??new MaintenanceGate();
  this.#automatic=automatic;this.#metadataFiles=options.metadataFiles;this.#discoverMetadata=options.discoverMetadataOnStart??false;if(options.metadataMonitor)this.#metadataMonitor=new MetadataMonitor(options.metadataFiles!,options.metadataMonitor,()=>{if(!this.#stopping)this.setInformation(this.#base);});
  this.reader=reader;this.binding=readNetworkBinding(reader);
  this.#base=structuredClone(options.information);this.#information=new ServerInformation(this.#base);
  this.#configuration=new ServerConfiguration(reader.snapshot());this.rpc=new JsonRpcDispatcher();this.endpoints=new EndpointRegistry(this.rpc);
  this.#network=new MoonrakerNetwork(this.rpc,{...options,thumbnails:this.#metadataFiles?.downloads??options.thumbnails,endpoints:this.endpoints,maxConnections:this.binding.maxConnections});
  if(options.gcodeStore)this.#gcodeStore=new GcodeStore(reader.section('data_store').getInt('gcode_store_size',{defaultValue:1000,minval:0,maxval:100000}),options.gcodeStore.maxBytes);
  if(options.temperatureStore)this.#temperatureStore=new TemperatureStoreRuntime(new TemperatureStore({...options.temperatureStore,capacity:reader.section('data_store').getInt('temperature_store_size',{defaultValue:1200,minval:1,maxval:100000})}),()=>this.#klippy?.cachedStatus??{});
  this.#sensorTransport=options.sensorTransport;this.#sensors=options.sensors;const releaseSensors=this.#sensors?registerSensors(this.endpoints,this.#sensors):()=>{};
  if(this.#sensorTransport){this.#mqttMacros=new MqttMacroPublisher(this.#sensorTransport,this.#sensorTransport.instanceName);this.#mqttStatus=new MqttStatusRuntime(this.#sensorTransport,readMqttStatusOptions(reader));}
  const releaseMqtt=this.#sensorTransport?registerMqttPublish(this.endpoints,this.#sensorTransport):()=>{};
  const releaseMqttSubscribe=this.#sensorTransport?registerMqttSubscribe(this.endpoints,this.#sensorTransport):()=>{};
  this.#database=options.database;const releaseDatabase=this.#database?registerDatabase(this.endpoints,this.#database):()=>{};
  if(options.history)this.#historyRuntime=new HistoryRuntime(options.history.repository,{auxiliary:options.history.auxiliary,metadata:options.history.metadata??(this.#metadataFiles?filename=>this.#metadataFiles!.historyMetadata(filename):undefined),onFailure:()=>{if(!this.#stopping)this.setInformation(this.#base);},notify:async event=>{
   if(this.#stopping)return;const signal=this.#startupAbort.signal;signal.throwIfAborted();const exists=await options.history!.fileExists(event.job.filename,event.job.metadata.modified,signal);signal.throwIfAborted();if(typeof exists!=='boolean')throw new ApiError(502,'Invalid history file existence result');
   this.#broadcastTracked('notify_history_changed',[{...event,job:{...event.job,exists}} as unknown as Json],this.#historyNotifications);
  }});
  this.#printApi=new PrintApi({backend:()=>this.#stopping?undefined:this.#klippy,maintenanceGate:this.maintenanceGate,beginStart:this.#historyRuntime?(event,request,lifetime)=>this.#historyRuntime!.beginPrint(event.filename,event.user,request,lifetime):undefined,onStartComplete:options.onPrintStartComplete});
  const releasePrint=registerPrintApi(this.endpoints,this.#printApi);
  const releaseHistoryIdle=this.#historyRuntime?this.maintenanceGate.registerIdle(()=>!this.#historyRuntime!.status.awaitingPrintStart):()=>{};
  const releaseHistory=options.history?registerHistory(this.endpoints,{...options.history,auxiliaryTotals:options.history.auxiliary?()=>this.#historyRuntime!.auxiliaryTotals():options.history.auxiliaryTotals},operation=>this.#historyRuntime!.mutate(operation)):()=>{};
  const releaseMaintenance=this.#database?registerDatabaseMaintenance(this.endpoints,this.#database,()=>this.#requireDatabaseIdle(),options.onDatabaseRestore?()=>{this.#databaseRestart.requested=true;void Promise.resolve().then(options.onDatabaseRestore).catch(error=>{this.#databaseRestart.error=error instanceof Error?error.message:'Database restart failed';});}:undefined,this.maintenanceGate):()=>{};
  const releaseTemperature=this.#temperatureStore?registerTemperatureStore(this.endpoints,this.#temperatureStore.store):()=>{};
  const releaseGcode=this.#gcodeStore?registerGcodeStore(this.endpoints,this.#gcodeStore):()=>{};
  const releaseMetadata=registerServerMetadata(this.endpoints,this.#information,this.#configuration,()=>this.#network.status.connections);
  const releaseExtensions=registerExtensions(this.endpoints,this.#network);
  this.#agentMethods=new AgentMethods(this.endpoints,this.#network,()=>this.#klippy,new Set(this.#mqttMacros?['publish_mqtt_topic']:[]));
  const releaseFiles=this.#metadataFiles?registerFileMetadata(this.endpoints,options.history?new HistoryFileMetadata(this.#metadataFiles,options.history.repository):this.#metadataFiles):()=>{};
  const releaseScan=this.#metadataFiles?registerFileMetascan(this.endpoints,this.#metadataFiles):()=>{};
  this.#release=()=>{releaseMqttSubscribe();releaseMqtt();releaseSensors();releaseHistoryIdle();releasePrint();releaseHistory();releaseMaintenance();releaseDatabase();releaseTemperature();releaseGcode();releaseScan();releaseFiles();this.#agentMethods.close();releaseExtensions();releaseMetadata();};
  if(this.#metadataFiles)fileOwners.add(this.#metadataFiles);
  if(this.#database)databaseOwners.add(this.#database);
  if(this.#sensors)sensorOwners.add(this.#sensors);
  if(this.#sensorTransport){this.#sensorTransport.enablePresence();mqttSensorOwners.add(this.#sensorTransport);}
 }
 static async load(filename:string,options:ConfiguredServerOptions):Promise<ConfiguredMoonraker>{
  if(options.sensorTransport!==undefined&&(!(options.sensorTransport instanceof MqttSensors)||!options.sensors||!options.sensorTransport.owns(options.sensors)||options.sensorTransport.status.closed||options.sensorTransport.status.started||mqttSensorOwners.has(options.sensorTransport)))throw new ConfigurationError('Invalid or already owned sensor transport');
  if(options.sensors!==undefined&&(!(options.sensors instanceof SensorStore)||options.sensors.status.closed||sensorOwners.has(options.sensors)))throw new ConfigurationError('Invalid or already owned sensor store');
  if(options.maintenanceGate!==undefined&&!(options.maintenanceGate instanceof MaintenanceGate))throw new ConfigurationError('Invalid maintenance gate');
  if(options.onDatabaseRestore!==undefined&&(typeof options.onDatabaseRestore!=='function'||!options.database))throw new ConfigurationError('Database restore requires a database and service restart owner');
  if(options.database!==undefined&&(!(options.database instanceof DatabaseStore)||options.database.status.closed||options.database.status.closing||databaseOwners.has(options.database)))throw new ConfigurationError('Invalid or already owned database');
  if(options.history!==undefined&&(!options.history||!(options.history.repository instanceof HistoryRepository)||!options.database||!options.history.repository.owns(options.database)||typeof options.history.fileExists!=='function'||options.history.metadata!==undefined&&typeof options.history.metadata!=='function'))throw new ConfigurationError('History requires its database and file existence owner');
  if(options.temperatureStore!==undefined&&(!options.temperatureStore||typeof options.temperatureStore!=='object'||Array.isArray(options.temperatureStore)))throw new ConfigurationError('Invalid temperature store options');
  if(options.gcodeStore!==undefined&&(!options.gcodeStore||typeof options.gcodeStore!=='object'||Array.isArray(options.gcodeStore)))throw new ConfigurationError('Invalid G-code store options');
  if(options.metadataMonitor!==undefined&&(!options.metadataFiles||!options.metadataMonitor||typeof options.metadataMonitor!=='object'||Array.isArray(options.metadataMonitor)))throw new ConfigurationError('Metadata monitoring requires a file owner');
  if(options.discoverMetadataOnStart!==undefined&&(typeof options.discoverMetadataOnStart!=='boolean'||options.discoverMetadataOnStart&&!options.metadataFiles))throw new ConfigurationError('Metadata discovery requires a file owner');
  if(options.metadataFiles!==undefined&&options.thumbnails!==undefined)throw new ConfigurationError('Metadata-owned thumbnails cannot be overridden');
  if(options.metadataFiles!==undefined&&(!(options.metadataFiles instanceof MetadataFiles)||options.metadataFiles.status.closed))throw new ConfigurationError('Invalid metadata file owner');
  if(options.onPrintStartComplete!==undefined&&typeof options.onPrintStartComplete!=='function')throw new ConfigurationError('Invalid print start observer');
  if(typeof options.authorize!=='function')throw new TypeError('Network authorization is required');
  if(options.klippy!==undefined&&(!options.klippy||typeof options.klippy!=='object'||Array.isArray(options.klippy)))throw new ConfigurationError('Invalid Klippy configuration owner');
  const reader=new ConfigurationReader(await loadConfiguration(filename,options.configurationLimits));
  const automatic=options.klippy?{...await readKlippyBinding(reader,options.klippy.pathContext,options.klippy.retryDelayMs),initialization:options.klippy.initialization??{}}:undefined;
  return new ConfiguredMoonraker(reader,options,automatic);
 }
 /** Explicitly attach one Klippy generation; no implicit device connection,
  * retry or replay is performed by HTTP server startup. */
 attachKlippy(path:string,options:KlippyAttachmentOptions={}):Promise<KlippySnapshot>{
  if(this.#automatic||this.#supervisor)throw new Error('Klippy connection is owned by configuration or the supervisor');
  if(this.#reconnecting)throw new Error('Klippy recovery already in progress');
  return this.#attachKlippy(path,options);
 }
 #attachKlippy(path:string,options:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  if(this.#stopping||this.#klippy)throw new Error('Klippy generation already attached or server stopping');
  if(this.#historyRuntime&&options.trackJobState===false)throw new ApiError(400,'History requires job state tracking');
  if(this.#mqttMacros&&options.remoteMethods&&Object.hasOwn(options.remoteMethods,'publish_mqtt_topic'))throw new ApiError(400,'MQTT remote method is reserved');
  options={...options,trackJobState:options.trackJobState??!!this.#database};
  this.#lastAttachment={path,options:{...options,...options.remoteMethods?{remoteMethods:{...options.remoteMethods}}:{}}};
  if(options.trackJobState)this.#jobState??=new JobState();
  let routedEndpoints:readonly string[]|undefined,routedInitialization=false;
  const runtime=new KlippyLifecycle({...options,...this.#mqttMacros?{remoteMethods:{...options.remoteMethods,publish_mqtt_topic:this.#mqttMacros.invoke}}:{},maintenanceGate:this.maintenanceGate,onRemoteMethodsReady:()=>this.#agentMethods.publishPending(runtime),version:this.#base.version,onJobChange:change=>{if(!this.#stopping)this.#historyRuntime?.observe(change);options.onJobChange?.(change);},onGcodeCommand:script=>{this.#gcodeStore?.record(script,'command');options.onGcodeCommand?.(script);},onGcode:(response,signal)=>{this.#gcodeStore?.record(response,'response');this.#broadcastGcode(response);return options.onGcode?.(response,signal);},onStatus:(status,time,signal)=>{this.#mqttStatus?.send(status as StatusView,time);return options.onStatus?.(status,time,signal);},onSubscriptionStatus:(id,status,time)=>{this.#subscriptions?.deliver(id,status,time);options.onSubscriptionStatus?.(id,status,time);},onSnapshot:snapshot=>{
   if(!snapshot.connected)this.#subscriptions?.close();
   if(snapshot.initialized&&snapshot.state==='ready'){this.#temperatureStore?.ready(runtime);this.#mqttStatus?.ready(runtime);}
   if(routedEndpoints!==snapshot.endpoints||routedInitialization!==snapshot.initialized){
   const exposed=new Set(snapshot.endpoints.filter(name=>!['list_endpoints','gcode/subscribe_output','register_remote_method','objects/subscribe'].includes(name))),added=new Map<string,()=>void>();
   if(snapshot.initialized&&snapshot.endpoints.includes('objects/subscribe'))exposed.add('objects/subscribe');
   try{for(const name of exposed)if(!this.#klippyRoutes.has(name))added.set(name,name==='objects/subscribe'?this.endpoints.register({endpoint:name,methods:['GET','POST'],remote:true,transports:['websocket','http']},(params,_verb,context)=>this.#subscriptions!.subscribe(params,context)):this.endpoints.register({endpoint:name,methods:['GET','POST'],remote:true},(params,_verb,context)=>runtime.request(name,{...params},{signal:context.signal})));}catch(error){for(const release of added.values())release();throw error;}
   for(const [name,release] of this.#klippyRoutes)if(!exposed.has(name)){release();this.#klippyRoutes.delete(name);}for(const [name,release] of added)this.#klippyRoutes.set(name,release);
   routedEndpoints=snapshot.endpoints;routedInitialization=snapshot.initialized;
   }
   if(!this.#stopping)this.setInformation({...this.#base,connected:snapshot.connected,state:snapshot.state,missingRequirements:snapshot.missingRequirements});
   for(const method of this.#klippyEvents.observe(snapshot)){
    if(!this.#stopping&&method==='notify_klippy_shutdown')this.#historyRuntime?.end('klippy_shutdown',this.#jobState?.lastStats??{});
    if(!this.#stopping&&method==='notify_klippy_disconnected')this.#historyRuntime?.end('klippy_disconnect',this.#jobState?.lastStats??{});
    this.#broadcastTracked(method,[],this.#klippyNotifications);
   }
  }},this.#jobState);this.#klippy=runtime;this.#subscriptions=new SubscriptionDelivery({signal:id=>this.#network.connectionSignal(id),subscribe:(id,objects,signal)=>runtime.subscribe(id,objects,signal),remove:id=>runtime.removeSubscription(id),send:(id,status,time)=>this.#network.dispatchNotification(id,'notify_status_update',[status as Json,time]),disconnect:id=>this.#network.disconnectClient(id),enabled:()=>!!this.#network.status.notifications});return runtime.initialize(path);
 }
 /** Explicit recovery only after disconnection. Drain the old generation and
  * recreate protocol state; never replay G-code or an uncertain old request. */
 reconnectKlippy(path?:string,options?:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  if(this.#automatic||this.#supervisor)return Promise.reject(new Error('Klippy connection is owned by configuration or the supervisor'));
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
  if(this.#automatic)throw new Error('Klippy connection is owned by configuration');
  this.#superviseKlippy(path,options,retryDelayMs);
 }
 #superviseKlippy(path:string,options:KlippyAttachmentOptions,retryDelayMs:number):void{
  if(this.#stopping||this.#klippy||this.#supervisor||this.#reconnecting)throw new Error('Klippy connection already owned or server stopping');
  const supervisor=new KlippySupervisor(async()=>{if(this.#klippy)await this.#reconnectKlippy();else await this.#attachKlippy(path,options);return this.#klippy!.signal;},()=>this.#klippy?.close()??Promise.resolve(),retryDelayMs);
  this.#supervisor=supervisor;supervisor.start();
 }
 get databaseRestoreStatus(){return {...this.#databaseRestart,state:this.#database?.status.restoreState??null};}
 #requireDatabaseIdle(){const runtime=this.#klippy;if(!runtime?.snapshot.connected||!runtime.snapshot.initialized||runtime.snapshot.state!=='ready')throw new ApiError(503,'Printer state is unavailable for database maintenance');const state=runtime.cachedStatus.print_stats?.state;if(state==='printing'||state==='paused')throw new ApiError(409,'Database maintenance is unavailable while printing or paused');if(!['standby','complete','cancelled','error'].includes(state as string))throw new ApiError(503,'Print state is unavailable for database maintenance');}
 get klippySupervisor(){return this.#supervisor?.status??null;}
 get printControlStatus(){return this.#printApi.status;}
 get mqttStatus(){return this.#mqttStatus?.status??null;}
 get mqttMacroStatus(){return this.#mqttMacros?.status??null;}
 get sensorTransportStatus(){return this.#sensorTransport?.status??null;}
 get sensorStatus(){return this.#sensors?{...this.#sensors.status,samples:this.#sensorSamples,error:this.#sensorError,notifications:{...this.#sensorNotifications}}:null;}
 get historyStatus(){return this.#historyRuntime?{...this.#historyRuntime.status,notifications:{...this.#historyNotifications}}:null;}
 async drainHistory():Promise<void>{await this.#historyRuntime?.drain();}
 get jobState(){return this.#jobState?{stats:this.#jobState.lastStats,event:this.#jobState.lastEvent}:null;}
 get cachedKlippyStatus(){return this.#klippy?.cachedStatus??null;}
 get temperatureStoreStatus(){return this.#temperatureStore?.status??null;}
 get gcodeStoreStatus(){return this.#gcodeStore?.status??null;}
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
 get klippyPeerCredentials(){return this.#klippy?.peerCredentials??null;}
 get klippyPeerCredentialError(){return this.#klippy?.peerCredentialError??null;}
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
 get metadataMonitor(){return this.#metadataMonitor?.status??null;}
 get metadataDiscovery(){return this.#metadataDiscovery?{...this.#metadataDiscovery}:null;}
 get metadataRecovery(){return this.#metadataRecovery?{...this.#metadataRecovery}:null;}
 /** Lifecycle owners may replace real state; serving HTTP never implies Klippy ready. */
 setInformation(snapshot:InformationSnapshot):void{
  if(this.#stopping)throw new Error('Configured server is stopping');
  const current=this.#klippy?.snapshot,copy=structuredClone(current?{...snapshot,connected:current.connected,state:current.state,missingRequirements:current.missingRequirements}:snapshot);const faulted=this.#metadataMonitor?.status.phase==='faulted';this.#information.replace({...copy,components:[...new Set([...copy.components,...this.#metadataMonitor?['metadata_monitor']:[]])],failedComponents:[...new Set([...copy.failedComponents,...faulted?['metadata_monitor']:[],...this.#historyRuntime?.status.failure?['history']:[],...this.#sensorError?['sensor']:[]])],warnings:[...new Set([...copy.warnings,...this.#historyRuntime?.status.failure?['History persistence failed; tracking requires restart']:[],...this.#sensorError?['Sensor sampling failed; restart required']:[],...faulted?['File metadata monitoring failed; cached file metadata is unavailable']:[],...this.reader.warnings(),...this.klippyRemoteMethodFailures.map(f=>`Klippy remote method registration failed: ${f.name}`)])]});this.#base=copy;
 }
 start():Promise<AddressInfo>{
  if(this.#stopping)return Promise.reject(new Error('Configured server is stopping'));
  if(this.#opening)return this.#opening;
  this.#opening=this.#start();return this.#opening;
 }
 async #start():Promise<AddressInfo>{
  try{
   this.reader.validate();this.reader.publish(this.#configuration);this.setInformation(this.#base);
   if(this.#metadataFiles)this.#metadataRecovery=await this.#metadataFiles.restoreSelected(this.#startupAbort.signal);
   if(this.#metadataMonitor)await this.#metadataMonitor.start();else if(this.#discoverMetadata)this.#metadataDiscovery=await this.#metadataFiles!.scanDiscovered(this.#startupAbort.signal);
   this.#startupAbort.signal.throwIfAborted();
   if(this.#database)await this.#database.sealTableRegistration();
   this.#startupAbort.signal.throwIfAborted();
   if(this.#sensorTransport)await this.#sensorTransport.start();
   this.#startupAbort.signal.throwIfAborted();
   const address=await this.#network.listen(this.binding.port,this.binding.host);
   this.#startupAbort.signal.throwIfAborted();
   if(this.#sensors){this.#sensorTimer=setInterval(()=>{
    if(this.#stopping)return;
    try{const changes=this.#sensors!.sample();this.#sensorSamples++;if(Object.keys(changes).length)this.#broadcastTracked('notify_sensor_update',[changes],this.#sensorNotifications);}
    catch(error){this.#sensorError=error instanceof Error?error.message:'Sensor sampling failed';clearInterval(this.#sensorTimer);this.#sensorTimer=undefined;this.setInformation(this.#base);}
   },1000);this.#sensorTimer.unref();}
   if(this.#automatic)this.#superviseKlippy(this.#automatic.path,this.#automatic.initialization,this.#automatic.retryDelayMs);
   return address;
  }catch(error){try{await this.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Configured server startup and cleanup failed');}throw error;}
 }
 notify(connectionId:number,method:string,params:readonly Json[]):boolean{return this.#network.notify(connectionId,method,params);}
 notifyAuthorized(connectionId:number,method:string,params:readonly Json[]){return this.#network.notifyAuthorized(connectionId,method,params);}
 connectionSignal(connectionId:number){return this.#network.connectionSignal(connectionId);}
 requestClient(id:number,method:string,params:ClientArguments=null,options:ClientRequestOptions={}){return this.#network.requestClient(id,method,params,options);}
 broadcast(method:string,params:readonly Json[],excluded:readonly number[]=[]){return this.#network.broadcast(method,params,excluded);}
 async close():Promise<void>{
  this.#stopping=true;clearInterval(this.#sensorTimer);this.#sensorTimer=undefined;const mqttStatusClosed=this.#mqttStatus?.close()??Promise.resolve();const mqttMacrosClosed=this.#mqttMacros?.close()??Promise.resolve();const sensorTransportClosed=this.#sensorTransport?.close()??Promise.resolve();this.#sensors?.close();this.#printApi.close();this.#startupAbort.abort(new Error('Configured server is stopping'));this.#subscriptions?.close();const historyClosed=this.#historyRuntime?.close(this.#jobState?.lastStats??{})??Promise.resolve();const databaseClosed=historyClosed.then(()=>this.#database?.close(),async error=>{try{await this.#database?.close();}catch(cleanup){throw new AggregateError([error,cleanup],'History and database cleanup failed');}throw error;});const settled=await Promise.allSettled([mqttStatusClosed,mqttMacrosClosed,sensorTransportClosed,databaseClosed,this.#temperatureStore?.close(),this.#supervisor?.stop(),this.#network.close(),this.#klippy?.close(),this.#metadataMonitor?.close(),this.#metadataFiles?.close()]);const errors=settled.filter(value=>value.status==='rejected').map(value=>value.reason);if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Configured server cleanup failed');for(const release of this.#klippyRoutes.values())release();this.#klippyRoutes.clear();this.#release();if(this.#metadataFiles)fileOwners.delete(this.#metadataFiles);if(this.#database)databaseOwners.delete(this.#database);
 }
}
