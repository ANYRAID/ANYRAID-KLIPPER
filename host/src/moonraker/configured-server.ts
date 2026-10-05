import {Webcams} from './webcams.ts';
import {SystemInformation,type SystemInformationSource} from './system-information.ts';
import {ProcStats,type ProcStatsSource} from './proc-stats.ts';
import {NativeHostNotifications} from './native-host-notifications.ts';
import {NativeRequestScope} from './native-request-scope.ts';
import {NativePrinterInformation,type NativePrinterIdentity} from './native-printer-info.ts';
import {ProductHostControl} from '../runtime/product-host-control.ts';
import {registerProductHostControl} from './product-host-api.ts';
import {NativeSubscriptions} from './native-subscriptions.ts';
import {NativeObjects,registerNativeObjects} from './native-objects.ts';
import {readNativeHostStatus,type NativeHostStatusSource,type NativeHostSnapshot} from './native-host-status.ts';
import {NativePrintUploads,registerNativeFileInfo} from './native-print-uploads.ts';
import {NativeConfigFiles} from './native-config-files.ts';
import {ProductPrintApi,registerProductPrintApi,type NativePrintCompatibility} from './product-print-api.ts';
import {PrintController} from '../operations/print.ts';
import {PrintJournal} from '../operations/print-journal.ts';
import type {PressureAdvancePort} from '../gcode/pressure-advance.ts';
import {MqttRpc,type MqttAuthorization} from './mqtt-rpc.ts';
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
import {registerNativeHistory} from './native-history.ts';
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
import {ApiKeyAuthorization} from './api-key-authorization.ts';
import {readAuthorizationOptions} from './authorization-config.ts';
import {ConfigurationReader} from './config-reader.ts';
import {ApiError,type RpcContext,JsonRpcDispatcher,type Json} from './rpc.ts';
import {EndpointRegistry} from './endpoints.ts';
import {ServerInformation,ServerConfiguration,registerServerMetadata,type InformationSnapshot} from './metadata.ts';
import {MoonrakerNetwork,type MoonrakerNetworkOptions} from './server.ts';
export interface NetworkBinding {readonly host:string;readonly port:number;readonly maxConnections:number;}
type KlippyAttachmentOptions=Omit<KlippyInitializationOptions,'version'|'onSnapshot'|'onRemoteMethodsReady'>;
const mqttSensorOwners=new WeakSet<MqttSensors>();
const sensorOwners=new WeakSet<SensorStore>();
const uploadOwners=new WeakSet<NativePrintUploads>();
// Process routes survive replacement. Mutations capture and drain their current
// device delegate themselves; never bind a retained route to the first scope.
const nativeProcessFileRoutes=new Set(['/printer/files/info','/server/files/roots','/server/files/list','/server/files/directory','/server/files/metadata','/server/files/thumbnails','/server/files/move','/server/files/copy','/server/files/delete_file']);
function assertNativeProcessResources(options:ConfiguredServerOptions){
 if(options.nativeDetached!==undefined&&options.nativeDetached!==true)throw new ConfigurationError('Invalid native detached mode');
 if(options.nativeDetached&&(options.productPrint||options.nativeUploads||options.nativeObjects||options.nativeHost||options.productPressure||options.productPrintCompatibility||options.klippy||options.history||options.onPrintStartComplete||!options.nativePrinterIdentity||!options.productHostControl))throw new ConfigurationError('Detached native startup requires process resources without a device owner');
 if(options.nativeProcessFiles===undefined&&options.nativeProcessHistory===undefined){if(options.nativeDetached)throw new ConfigurationError('Detached native startup requires process files and history');return;}
 const files=options.nativeProcessFiles,journal=options.nativeProcessHistory;
 if(!(files instanceof NativePrintUploads)||files.metadataOwner||files.status.closed||uploadOwners.has(files)||!options.nativeDetached&&options.nativeUploads?.metadataOwner!==files||options.metadataFiles||!(journal instanceof PrintJournal)||journal.closed||!options.nativeDetached&&!options.productPrint?.usesJournal(journal))throw new ConfigurationError('Native process files and history require their matching device borrowers');
}
const nativeDeviceFields=new Set(['productPrint','productPressure','productPrintCompatibility','nativeHost','nativeObjects','maintenanceGate','nativeUploads','nativeDetached']);
function plainProcessValue(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&(Array.isArray(value)||[Object.prototype,null].includes(Object.getPrototypeOf(value)));}
function copyProcessValue(value:unknown,seen=new Map<object,Record<string,unknown>>()):unknown{
 if(!plainProcessValue(value))return value;if(seen.has(value))return seen.get(value);
 const copy=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));seen.set(value,copy);
 for(const [key,item]of Object.entries(value))Object.defineProperty(copy,key,{value:copyProcessValue(item,seen),enumerable:true,writable:true,configurable:true});return copy;
}
function sameProcessValue(previous:unknown,next:unknown,seen=new Map<object,object>()):boolean{
 if(Object.is(previous,next))return true;if(!plainProcessValue(previous)||!plainProcessValue(next)||Object.getPrototypeOf(previous)!==Object.getPrototypeOf(next))return false;
 if(seen.has(previous))return seen.get(previous)===next;seen.set(previous,next);
 const keys=Object.keys(previous);return keys.length===Object.keys(next).length&&keys.every(key=>Object.hasOwn(next,key)&&sameProcessValue(previous[key],next[key],seen));
}
function nativeProcessOptions(options:ConfiguredServerOptions|ConfiguredAuthorizationOptions):Record<string,unknown>{return Object.fromEntries(Object.entries(options).filter(([key,value])=>value!==undefined&&!nativeDeviceFields.has(key)).map(([key,value])=>[key,copyProcessValue(value)]));}
const fileOwners=new WeakSet<MetadataFiles>();
const configFileOwners=new WeakSet<NativeConfigFiles>();
function validateConfigFiles(options:ConfiguredServerOptions|ConfiguredAuthorizationOptions){if(options.configFiles!==undefined&&(!(options.configFiles instanceof NativeConfigFiles)||options.configFiles.status.closed||configFileOwners.has(options.configFiles)||!options.nativeProcessFiles))throw new ConfigurationError('Config files require an unowned process resource and native process file routes');}
const databaseOwners=new WeakSet<DatabaseStore>();
const notificationMetrics=()=>({received:0,disabled:0,rejected:0,sent:0,denied:0,closed:0,overflow:0,failed:0});
const nativeGenerationNotifications=new Set(['notify_gcode_response','notify_print_state_changed','notify_history_changed','notify_filelist_changed','notify_klippy_ready','notify_klippy_shutdown']);
export interface ConfiguredServerOptions extends Omit<MoonrakerNetworkOptions,'endpoints'|'maxConnections'> {
 /** Supplied by actual component/Klippy owners, never inferred from listening. */
 information:InformationSnapshot;
 maintenanceGate?:MaintenanceGate;
 /** Native device owner; replaces legacy print routes and excludes Klippy attachment. */
 productPrint?:PrintController;
 /** Trusted process startup before any device acquisition. No print controller,
  * hardware status source, automatic connection or fake readiness is installed. */
 nativeDetached?:true;
 /** Process resources survive device retirement; final server closure drains
  * files, and the process factory closes the authoritative journal afterwards. */
 nativeProcessFiles?:NativePrintUploads;
 nativeProcessHistory?:PrintJournal;
 nativePrinterIdentity?:NativePrinterIdentity;
 productPrintCompatibility?:NativePrintCompatibility;
 productHostControl?:ProductHostControl;
 productPressure?:PressureAdvancePort;
 /** Live native owner snapshot; never a replacement for Klippy state. */
 nativeHost?:NativeHostStatusSource;
 nativeObjects?:NativeObjects;
 onPrintStartComplete?:PrintApiOptions['onStartComplete'];
 /** Enable the G-code portion of data_store; temperature sampling is separate. */
 gcodeStore?:{maxBytes?:number};
 procStats?:{source?:ProcStatsSource};
 systemInformation?:{source?:SystemInformationSource};
 /** Transfers telemetry store lifetime on successful load; samples once per second after listening. */
 sensors?:SensorStore;
 /** Transfers an unstarted MQTT source owned by the supplied sensor store. */
 sensorTransport?:MqttSensors;
 /** Explicit authorization for broker-originated calls; no HTTP identity is inferred. */
 mqttAuthorize?:MqttAuthorization;
 temperatureStore?:{maxSensors?:number;maxSlots?:number;previous?:TemperatureStore};
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
export interface ConfiguredAuthorizationOptions extends Omit<ConfiguredServerOptions,'authorize'|'authorizeNotification'|'authorizeSubscriptionConnection'> {
 authorize?:never;authorizeNotification?:never;authorizeSubscriptionConnection?:never;
 /** Persistent database ownership transfers when assembly is constructed. */
 database:DatabaseStore;
 /** Stable externally provisioned origin, independent of an ephemeral listener. */
 authorization:{issuer:string};
}
/** Device generation only. Process identity, authorization and database remain
 * with the listening server; the caller owns physical startup and cleanup. */
export interface NativePrinterBinding {
 controller:PrintController;gate:MaintenanceGate;host:NativeHostStatusSource;objects:NativeObjects;
 pressure?:PressureAdvancePort;compatibility?:NativePrintCompatibility;uploads?:NativePrintUploads;
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
 #configHostControl:ProductHostControl|undefined;
 #maintenanceGate:MaintenanceGate;
 get maintenanceGate(){return this.#maintenanceGate;}
 #webcams:Webcams|undefined;#webcamNotifications=notificationMetrics();
 #authorization:ApiKeyAuthorization|undefined;#releaseAuthorization:()=>void=()=>{};
 /** Local provisioning only; never serialized into server information. */
 get authorization(){return this.#authorization;}
 readonly reader:ConfigurationReader;readonly binding:NetworkBinding;
 readonly rpc:JsonRpcDispatcher;readonly endpoints:EndpointRegistry;
 #metadataMonitor:MetadataMonitor|undefined;
 #discoverMetadata=false;#metadataDiscovery:{restored:number;scanned:number;unavailable:number;unsupported:number}|null=null;
 #metadataFiles:MetadataFiles|undefined;#startupAbort=new AbortController();#metadataRecovery:{restored:number;unavailable:number}|null=null;
 #network:MoonrakerNetwork;#information:ServerInformation;#configuration:ServerConfiguration;
 #nativeSubscriptions:NativeSubscriptions|undefined;#subscriptions:SubscriptionDelivery|undefined;#klippy:KlippyLifecycle|undefined;#klippyRoutes=new Map<string,()=>void>();
 #base:InformationSnapshot;#release:()=>void;#opening:Promise<AddressInfo>|undefined;#stopping=false;
 #gcodeNotifications=notificationMetrics();#klippyNotifications=notificationMetrics();#klippyEvents=new KlippyNotifications();
 #gcodeStore:GcodeStore|undefined;
 #systemInformation:SystemInformation|undefined;
 #procStats:ProcStats|undefined;#procNotifications=notificationMetrics();
 #temperatureStore:TemperatureStoreRuntime|undefined;
 #nativeTemperatureObjects:NativeObjects|undefined;
 #nativeHistory:ReturnType<typeof registerNativeHistory>|undefined;
 #database:DatabaseStore|undefined;#historyRuntime:HistoryRuntime|undefined;#historyNotifications=notificationMetrics();
 #mqttRpc:MqttRpc|undefined;
 #mqttStatus:MqttStatusRuntime|undefined;
 #mqttMacros:MqttMacroPublisher|undefined;
 #sensorTransport:MqttSensors|undefined;
 #sensors:SensorStore|undefined;#sensorTimer:ReturnType<typeof setInterval>|undefined;#sensorError:string|null=null;#sensorSamples=0;#sensorNotifications=notificationMetrics();
 #nativeUploads:NativePrintUploads|undefined;#configFiles:NativeConfigFiles|undefined;
 #nativeProcessFiles:NativePrintUploads|undefined;#nativeProcessHistory:PrintJournal|undefined;#nativeController:PrintController|undefined;
 #printApi:PrintApi|ProductPrintApi|undefined;
 #nativeLifecycle:NativeHostNotifications|undefined;
 #nativeScope:NativeRequestScope|undefined;#nativeHost:NativeHostStatusSource|undefined;
 #nativeRetiredSnapshot:NativeHostSnapshot|undefined;#nativeRetirement:Promise<void>|undefined;
 #nativeReleases:(()=>void)[]=[];#nativeReattaching=false;#nativeCanAttach=false;#nativeGeneration=0;
 #nativeRetirementDrained=false;#nativeLifecycleEnabled=false;
 #nativeProcessOptions:Record<string,unknown>|undefined;#configurationPath:string|undefined;
 #printStateTask:Promise<void>|undefined;#printNotifications=notificationMetrics();
 #fileNotifications=notificationMetrics();
 #releaseFileChanges:()=>void=()=>{};
 #databaseRestart={requested:false,error:null as string|null};
 #agentMethods:AgentMethods;#jobState:JobState|undefined;
 #reconnecting=false;#lastAttachment:{path:string;options:KlippyAttachmentOptions}|undefined;
 #supervisor:KlippySupervisor|undefined;
 #automatic:{path:string;retryDelayMs:number;initialization:KlippyAttachmentOptions}|undefined;
 private constructor(reader:ConfigurationReader,options:ConfiguredServerOptions,automatic?:{path:string;retryDelayMs:number;initialization:KlippyAttachmentOptions}){
  options={...options};
  assertNativeProcessResources(options);
  if(options.sensorTransport!==undefined&&(!(options.sensorTransport instanceof MqttSensors)||!options.sensors||!options.sensorTransport.owns(options.sensors)||options.sensorTransport.status.closed||options.sensorTransport.status.started||options.sensorTransport.status.rpcBound||mqttSensorOwners.has(options.sensorTransport)))throw new ConfigurationError('Invalid or already owned sensor transport');
  if(options.sensors&&(sensorOwners.has(options.sensors)||options.sensors.status.closed))throw new ConfigurationError('Invalid or already owned sensor store');
  if(options.history?.auxiliary&&options.history.auxiliaryTotals)throw new ConfigurationError('History auxiliary source must own its reset fields');
  if(options.database&&(databaseOwners.has(options.database)||options.database.status.closed||options.database.status.closing))throw new ConfigurationError('Invalid or already owned database');
  if(options.metadataFiles&&fileOwners.has(options.metadataFiles))throw new ConfigurationError('Metadata files already have a server owner');
  if(options.mqttAuthorize!==undefined&&(typeof options.mqttAuthorize!=='function'||!options.sensorTransport))throw new ConfigurationError('MQTT authorization requires a transport');
  const mqttApi=options.sensorTransport?reader.section('mqtt').getBoolean('enable_moonraker_api',{defaultValue:!!options.mqttAuthorize}):false;
  if(mqttApi&&!options.mqttAuthorize)throw new ConfigurationError('MQTT API requires explicit broker authorization');
  const mqttApiQos=mqttApi?reader.section('mqtt').getInt('api_qos',{defaultValue:0,minval:0,maxval:2}) as 0|1|2:0;
  if(options.nativeUploads!==undefined&&(!(options.nativeUploads instanceof NativePrintUploads)||!options.productPrint||!options.maintenanceGate||!options.nativeUploads.usesGate(options.maintenanceGate)||options.nativeUploads.status.closed||options.nativeUploads.status.pending||(!options.nativeUploads.metadataOwner&&options.nativeUploads.status.metadata.pending)||options.nativeUploads.status.downloads||options.nativeUploads.status.authorizing||uploadOwners.has(options.nativeUploads)))throw new ConfigurationError('Native uploads require an unowned admission layer and the native print gate');
  validateConfigFiles(options);this.#configFiles=options.configFiles;
  this.#maintenanceGate=options.maintenanceGate??new MaintenanceGate();this.#configHostControl=options.productHostControl;
  if(options.productPrint&&(automatic||options.history||options.onPrintStartComplete))throw new ConfigurationError('Native print owner cannot share Klippy or legacy history/start hooks');
  this.#automatic=automatic;this.#metadataFiles=options.metadataFiles;this.#discoverMetadata=options.discoverMetadataOnStart??false;if(options.metadataMonitor)this.#metadataMonitor=new MetadataMonitor(options.metadataFiles!,options.metadataMonitor,()=>{if(!this.#stopping)this.setInformation(this.#base);});
  if(reader.prefixSections('webcam ').length&&!options.database)throw new ConfigurationError('Webcam configuration requires a database');
  this.reader=reader;this.binding=readNetworkBinding(reader);
  this.#base=structuredClone(options.information);this.#information=new ServerInformation(this.#base);
  this.#nativeScope=options.productPrint||options.nativeDetached?new NativeRequestScope():undefined;this.#nativeHost=options.nativeHost;this.#nativeCanAttach=!!options.nativeDetached||!!options.productPrint&&!!options.nativeHost&&!!options.nativeObjects;this.#nativeGeneration=options.productPrint?1:0;this.#nativeLifecycleEnabled=!!options.nativePrinterIdentity&&(!!options.nativeHost||!!options.nativeDetached);
  if(options.nativeDetached){this.maintenanceGate.invalidate();this.#nativeRetirement=Promise.resolve();this.#nativeRetirementDrained=true;this.#nativeRetiredSnapshot={group_state:'stopped',hardware_state:'stopped',print_state:'idle',homed_axes:'',closing:true,admission_closed:true,maintenance:false,mcus:[]};}
  const initialScope=this.#nativeScope;this.#nativeProcessFiles=options.nativeProcessFiles;this.#nativeProcessHistory=options.nativeProcessHistory;this.#nativeController=options.productPrint;
  const nativeHost=options.nativeHost||options.nativeDetached?()=>this.#nativeRetiredSnapshot??this.#nativeHost!():undefined;
  this.#configuration=new ServerConfiguration(reader.snapshot());this.rpc=new JsonRpcDispatcher();this.endpoints=new EndpointRegistry(this.rpc,(path,handler)=>this.#nativeProcessFiles&&nativeProcessFileRoutes.has(path)||this.#nativeProcessHistory&&path.startsWith('/server/history/')?handler:this.#nativeScope?.wrap(path,handler)??handler);
  const networkOptions={...options};for(const key of ['productPrint','nativeHost','nativeObjects','nativePrinterIdentity','productPressure','productHostControl','productPrintCompatibility','maintenanceGate','nativeDetached'] as const)delete networkOptions[key];
  this.#network=new MoonrakerNetwork(this.rpc,{...networkOptions,nativeUploads:this.#nativeProcessFiles??options.nativeUploads,thumbnails:this.#metadataFiles?.downloads??options.thumbnails,endpoints:this.endpoints,maxConnections:this.binding.maxConnections},this.#nativeScope?.signal);
  if(options.nativeDetached)this.#nativeScope!.retire();
  if(options.gcodeStore)this.#gcodeStore=new GcodeStore(reader.section('data_store').getInt('gcode_store_size',{defaultValue:1000,minval:0,maxval:100000}),options.gcodeStore.maxBytes);
  this.#nativeTemperatureObjects=options.nativeObjects;
  if(options.temperatureStore||options.nativeObjects||options.nativeDetached)this.#temperatureStore=new TemperatureStoreRuntime(new TemperatureStore({...options.temperatureStore,capacity:reader.section('data_store').getInt('temperature_store_size',{defaultValue:1200,minval:1,maxval:100000})},options.temperatureStore?.previous),()=>this.#klippy?.cachedStatus??{});
  this.#sensorTransport=options.sensorTransport;this.#sensors=options.sensors;const releaseSensors=this.#sensors?registerSensors(this.endpoints,this.#sensors):()=>{};
  if(this.#sensorTransport){this.#mqttMacros=new MqttMacroPublisher(this.#sensorTransport,this.#sensorTransport.instanceName);this.#mqttStatus=new MqttStatusRuntime(this.#sensorTransport,readMqttStatusOptions(reader));}
  const releaseMqtt=this.#sensorTransport?registerMqttPublish(this.endpoints,this.#sensorTransport):()=>{};
  const releaseMqttSubscribe=this.#sensorTransport?registerMqttSubscribe(this.endpoints,this.#sensorTransport):()=>{};
  this.#database=options.database;if(this.#database)this.#webcams=new Webcams(reader,this.#database,event=>{if(!this.#stopping)this.#broadcastTracked('notify_webcams_changed',[event],this.#webcamNotifications);});const releaseWebcams=this.#webcams?.register(this.endpoints)??(()=>{});const releaseDatabase=this.#database?registerDatabase(this.endpoints,this.#database):()=>{};
  if(options.history)this.#historyRuntime=new HistoryRuntime(options.history.repository,{auxiliary:options.history.auxiliary,metadata:options.history.metadata??(this.#metadataFiles?filename=>this.#metadataFiles!.historyMetadata(filename):undefined),onFailure:()=>{if(!this.#stopping)this.setInformation(this.#base);},notify:async event=>{
   if(this.#stopping)return;const signal=this.#startupAbort.signal;signal.throwIfAborted();const exists=await options.history!.fileExists(event.job.filename,event.job.metadata.modified,signal);signal.throwIfAborted();if(typeof exists!=='boolean')throw new ApiError(502,'Invalid history file existence result');
   this.#broadcastTracked('notify_history_changed',[{...event,job:{...event.job,exists}} as unknown as Json],this.#historyNotifications);
  }});
  this.#nativeUploads=options.nativeUploads;this.#nativeUploads?.bindPrintController(options.productPrint!);if(this.#nativeProcessFiles&&this.#nativeUploads)this.#nativeProcessFiles.bindDeviceFiles(this.#nativeUploads,initialScope!.signal);
  this.#nativeProcessFiles?.bindOfflineReadiness(()=>!this.#stopping&&this.#nativeRetirementDrained&&this.#nativeRetiredSnapshot?.hardware_state==='stopped');
  const releaseProcessFiles=this.#nativeProcessFiles?registerNativeFileInfo(this.endpoints,this.#nativeProcessFiles,{configFiles:this.#configFiles}):()=>{};
  let releaseUploads=this.#nativeUploads?registerNativeFileInfo(this.endpoints,this.#nativeUploads,{metadata:!this.#metadataFiles,readRoutes:!this.#nativeProcessFiles,deleteRoute:!this.#nativeProcessFiles}):()=>{};
  this.#printApi=options.productPrint?new ProductPrintApi(options.productPrint,this.maintenanceGate,options.productPressure,options.productPrintCompatibility):options.nativeDetached?undefined:new PrintApi({backend:()=>this.#stopping?undefined:this.#klippy,maintenanceGate:this.maintenanceGate,beginStart:this.#historyRuntime?(event,request,lifetime)=>this.#historyRuntime!.beginPrint(event.filename,event.user,request,lifetime):undefined,onStartComplete:options.onPrintStartComplete});
  const releaseConfigWriter=this.#configFiles?.bindWriter(context=>this.#beginConfigWrite(context))??(()=>{});
  const releaseConfigSave=this.#configFiles?.registerSave(this.endpoints)??(()=>{});
  const releaseConfigChanges=this.#configFiles?.observeChanges(event=>this.#broadcastTracked('notify_filelist_changed',[event],this.#fileNotifications))??(()=>{});
  const releaseHostControl=options.productHostControl?registerProductHostControl(this.endpoints,options.productHostControl):()=>{};
  let releasePrint=this.#printApi instanceof ProductPrintApi?registerProductPrintApi(this.endpoints,this.#printApi):this.#printApi?registerPrintApi(this.endpoints,this.#printApi):this.#registerDetachedNativeRoutes();
  const releaseHistoryIdle=this.#historyRuntime?this.maintenanceGate.registerIdle(()=>!this.#historyRuntime!.status.awaitingPrintStart):()=>{};
  let releaseHistory=options.history?registerHistory(this.endpoints,{...options.history,auxiliaryTotals:options.history.auxiliary?()=>this.#historyRuntime!.auxiliaryTotals():options.history.auxiliaryTotals},operation=>this.#historyRuntime!.mutate(operation)):(options.productPrint&&this.#nativeUploads||this.#nativeProcessHistory&&this.#nativeProcessFiles)?(this.#nativeHistory=registerNativeHistory(this.endpoints,(this.#nativeProcessHistory??options.productPrint)!, (this.#nativeProcessFiles??this.#nativeUploads)!,event=>{if(!this.#stopping)this.#broadcastTracked('notify_history_changed',[event],this.#historyNotifications);},this.#nativeProcessHistory?()=>this.#nativeController:undefined)):()=>{};
  const releaseMaintenance=this.#database?registerDatabaseMaintenance(this.endpoints,this.#database,()=>this.#requireDatabaseIdle(),options.onDatabaseRestore?()=>{this.#databaseRestart.requested=true;void Promise.resolve().then(options.onDatabaseRestore).catch(error=>{this.#databaseRestart.error=error instanceof Error?error.message:'Database restart failed';});}:undefined,()=>this.maintenanceGate):()=>{};
  const releaseTemperature=this.#temperatureStore?registerTemperatureStore(this.endpoints,this.#temperatureStore.store):()=>{};
  if(options.systemInformation)this.#systemInformation=new SystemInformation(options.systemInformation.source);
  const releaseSystem=this.#systemInformation?this.endpoints.register({endpoint:'/machine/system_info',methods:['GET']},()=>this.#systemInformation!.snapshot()):()=>{};
  if(options.procStats)this.#procStats=new ProcStats({...options.procStats,connections:()=>this.#network.status.connections,notify:(method,value)=>this.#broadcastTracked(method,[value],this.#procNotifications)});
  const releaseProc=this.#procStats?this.endpoints.register({endpoint:'/machine/proc_stats',methods:['GET']},()=>this.#procStats!.snapshot()):()=>{};
  const releaseGcode=this.#gcodeStore?registerGcodeStore(this.endpoints,this.#gcodeStore):()=>{};
  if(options.nativeObjects){
   const owner=new NativeSubscriptions(options.nativeObjects,{deliver:(id,status,time)=>this.#subscriptions?.deliver(id,status,time),disconnect:id=>this.#network.disconnectClient(id)});this.#nativeSubscriptions=owner;
   this.#subscriptions=new SubscriptionDelivery({signal:id=>this.#network.connectionSignal(id),subscribe:(id,objects,signal)=>owner.subscribe(id,objects,signal),remove:id=>owner.remove(id),send:(id,status,time)=>this.#network.dispatchNotification(id,'notify_status_update',[status as Json,time],initialScope?.signal),disconnect:id=>this.#network.disconnectClient(id),enabled:()=>!!this.#network.status.notifications});
  }
  let releaseNativeSubscribe=options.nativeObjects?this.endpoints.register({endpoint:'objects/subscribe',methods:['GET','POST'],remote:true,transports:['websocket','http']},(params,_verb,context)=>this.#subscriptions!.subscribe(params,context)):()=>{};
  let releaseObjects=options.nativeObjects?registerNativeObjects(this.endpoints,options.nativeObjects):()=>{};
  // No device lifecycle sampler exists before the first real attachment.
  if(options.nativePrinterIdentity&&nativeHost&&!options.nativeDetached)this.#nativeLifecycle=new NativeHostNotifications(nativeHost,method=>this.#broadcastTracked(method,[],this.#klippyNotifications));
  const releaseMetadata=registerServerMetadata(this.endpoints,this.#information,this.#configuration,()=>this.#network.status.connections,nativeHost,options.nativePrinterIdentity?new NativePrinterInformation(options.nativePrinterIdentity):undefined);
  const releaseExtensions=registerExtensions(this.endpoints,this.#network);
  this.#agentMethods=new AgentMethods(this.endpoints,this.#network,()=>this.#klippy,new Set(this.#mqttMacros?['publish_mqtt_topic']:[]));
  const releaseFiles=this.#metadataFiles?registerFileMetadata(this.endpoints,options.history?new HistoryFileMetadata(this.#metadataFiles,options.history.repository):this.#metadataFiles):()=>{};
  const releaseScan=this.#metadataFiles?registerFileMetascan(this.endpoints,this.#metadataFiles):()=>{};
  let releaseFileChanges=(this.#nativeProcessFiles??this.#nativeUploads)?.observeChanges(event=>this.#broadcastTracked('notify_filelist_changed',[event],this.#fileNotifications))??(()=>{});
  this.#releaseFileChanges=releaseFileChanges;
  if(options.productPrint||options.nativeDetached){this.#nativeReleases.push(releaseNativeSubscribe,releaseObjects,releaseUploads,releasePrint);releaseNativeSubscribe=releaseObjects=releaseUploads=releasePrint=()=>{};if(!this.#nativeProcessFiles){this.#nativeReleases.push(releaseFileChanges);releaseFileChanges=()=>{};}if(!this.#nativeProcessHistory){this.#nativeReleases.push(releaseHistory);releaseHistory=()=>{};}}
  this.#release=()=>{releaseConfigChanges();releaseConfigSave();releaseConfigWriter();this.#releaseNativeBindings();releaseProcessFiles();releaseWebcams();releaseFileChanges();releaseHostControl();releaseNativeSubscribe();releaseObjects();releaseUploads();releaseMqttSubscribe();releaseMqtt();releaseSensors();releaseHistoryIdle();releasePrint();releaseHistory();releaseMaintenance();releaseDatabase();releaseTemperature();releaseSystem();releaseProc();releaseGcode();releaseScan();releaseFiles();this.#agentMethods.close();releaseExtensions();releaseMetadata();};
  if(mqttApi)this.#mqttRpc=new MqttRpc(this.rpc,this.#sensorTransport!,this.#sensorTransport!.instanceName,options.mqttAuthorize!,mqttApiQos);
  if(this.#sensorTransport){if(this.#mqttRpc)this.#sensorTransport.bindRpc(this.#mqttRpc.receive,mqttApiQos);this.#sensorTransport.enablePresence();mqttSensorOwners.add(this.#sensorTransport);}
  if(this.#metadataFiles)fileOwners.add(this.#metadataFiles);
  if(this.#database)databaseOwners.add(this.#database);
  if(this.#configFiles)configFileOwners.add(this.#configFiles);
  if(this.#sensors)sensorOwners.add(this.#sensors);
  if(this.#nativeUploads)uploadOwners.add(this.#nativeUploads);
  if(this.#nativeProcessFiles)uploadOwners.add(this.#nativeProcessFiles);
  // Constructor closures retain process options only, not old device readers.
  for(const key of nativeDeviceFields)delete (options as unknown as Record<string,unknown>)[key];
 }
 static async #prepare(filename:string,options:ConfiguredServerOptions){
  assertNativeProcessResources(options);
  if(options.productHostControl!==undefined&&(!(options.productHostControl instanceof ProductHostControl)||!options.productPrint&&!options.nativeDetached))throw new ConfigurationError('Host control requires a native print owner');
  if(options.nativeObjects!==undefined&&(!(options.nativeObjects instanceof NativeObjects)||!options.productPrint))throw new ConfigurationError('Native objects require a native print owner');
  if(options.productPrintCompatibility!==undefined&&(!options.productPrint||typeof options.productPrintCompatibility.start!=='function'))throw new ConfigurationError('Standard print compatibility requires a native owner and policy');
  if(options.nativePrinterIdentity!==undefined&&(!options.nativeDetached&&(!options.productPrint||!options.nativeHost)))throw new ConfigurationError('Native printer information requires a native host');
  if(options.productPressure!==undefined&&!options.productPrint)throw new ConfigurationError('Native pressure control requires a native print owner');
  if(options.nativeHost!==undefined&&(typeof options.nativeHost!=='function'||!options.productPrint))throw new ConfigurationError('Native host status requires a native print owner');
  if(options.sensorTransport!==undefined&&(!(options.sensorTransport instanceof MqttSensors)||!options.sensors||!options.sensorTransport.owns(options.sensors)||options.sensorTransport.status.closed||options.sensorTransport.status.started||options.sensorTransport.status.rpcBound||mqttSensorOwners.has(options.sensorTransport)))throw new ConfigurationError('Invalid or already owned sensor transport');
  if(options.sensors!==undefined&&(!(options.sensors instanceof SensorStore)||options.sensors.status.closed||sensorOwners.has(options.sensors)))throw new ConfigurationError('Invalid or already owned sensor store');
  if(options.nativeUploads!==undefined&&(!(options.nativeUploads instanceof NativePrintUploads)||!options.productPrint||!options.maintenanceGate||!options.nativeUploads.usesGate(options.maintenanceGate)||options.nativeUploads.status.closed||options.nativeUploads.status.pending||(!options.nativeUploads.metadataOwner&&options.nativeUploads.status.metadata.pending)||options.nativeUploads.status.downloads||options.nativeUploads.status.authorizing||uploadOwners.has(options.nativeUploads)))throw new ConfigurationError('Native uploads require an unowned admission layer and the native print gate');
  validateConfigFiles(options);
  if(options.maintenanceGate!==undefined&&!(options.maintenanceGate instanceof MaintenanceGate))throw new ConfigurationError('Invalid maintenance gate');
  if(options.onDatabaseRestore!==undefined&&(typeof options.onDatabaseRestore!=='function'||!options.database))throw new ConfigurationError('Database restore requires a database and service restart owner');
  if(options.database!==undefined&&(!(options.database instanceof DatabaseStore)||options.database.status.closed||options.database.status.closing||databaseOwners.has(options.database)))throw new ConfigurationError('Invalid or already owned database');
  if(options.history!==undefined&&(!options.history||!(options.history.repository instanceof HistoryRepository)||!options.database||!options.history.repository.owns(options.database)||typeof options.history.fileExists!=='function'||options.history.metadata!==undefined&&typeof options.history.metadata!=='function'))throw new ConfigurationError('History requires its database and file existence owner');
  if(options.temperatureStore!==undefined&&(!options.temperatureStore||typeof options.temperatureStore!=='object'||Array.isArray(options.temperatureStore)))throw new ConfigurationError('Invalid temperature store options');
  if(options.systemInformation!==undefined&&(!options.systemInformation||typeof options.systemInformation!=='object'||Array.isArray(options.systemInformation)))throw new ConfigurationError('Invalid system information options');
  if(options.procStats!==undefined&&(!options.procStats||typeof options.procStats!=='object'||Array.isArray(options.procStats)))throw new ConfigurationError('Invalid process statistics options');
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
  return {reader,automatic};
 }
 static async load(filename:string,options:ConfiguredServerOptions):Promise<ConfiguredMoonraker>{
  const {reader,automatic}=await this.#prepare(filename,options),server=new ConfiguredMoonraker(reader,options,automatic);server.#configurationPath=filename;server.#nativeProcessOptions=nativeProcessOptions(options);return server;
 }
 /** Configuration-owned native authorization; does not listen or switch any
  * printer entry point. Failed initialization closes transferred resources. */
 static async loadAuthorized(filename:string,options:ConfiguredAuthorizationOptions):Promise<ConfiguredMoonraker>{
  if(!options.database||!options.authorization||typeof options.authorization.issuer!=='string')throw new ConfigurationError('Native authorization requires a database and stable issuer');
  for(const name of ['authorize','authorizeNotification','authorizeSubscriptionConnection'])if(name in options)throw new ConfigurationError('Native authorization cannot share external authorization callbacks');
  let auth:ApiKeyAuthorization|undefined;
  const owner=()=>{if(!auth)throw new ApiError(503,'Authorization is not initialized');return auth;};
  const resolved:ConfiguredServerOptions={...options,
   authorize:(method,params,context)=>owner().authorize(method,params,context),
   authorizeNotification:(method,params,context)=>owner().networkOptions.authorizeNotification!(method,params,context),
   authorizeSubscriptionConnection:(source,target)=>owner().networkOptions.authorizeSubscriptionConnection!(source,target)
  };
  const {reader,automatic}=await this.#prepare(filename,resolved),policy=readAuthorizationOptions(reader,options.authorization.issuer);
  const server=new ConfiguredMoonraker(reader,resolved,automatic);
  server.#configurationPath=filename;server.#nativeProcessOptions=nativeProcessOptions(options);
  try{
   auth=await ApiKeyAuthorization.open(options.database,policy);server.#authorization=auth;
   server.#releaseAuthorization=auth.register(server.endpoints,server);
   server.setInformation({...server.#base,components:[...new Set([...server.#base.components,'authorization'])]});return server;
  }catch(error){try{await server.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Authorization initialization and cleanup failed');}throw error;}
 }
 /** Explicitly attach one Klippy generation; no implicit device connection,
  * retry or replay is performed by HTTP server startup. */
 attachKlippy(path:string,options:KlippyAttachmentOptions={}):Promise<KlippySnapshot>{
  if(this.#automatic||this.#supervisor)throw new Error('Klippy connection is owned by configuration or the supervisor');
  if(this.#reconnecting)throw new Error('Klippy recovery already in progress');
  return this.#attachKlippy(path,options);
 }
 #attachKlippy(path:string,options:KlippyAttachmentOptions):Promise<KlippySnapshot>{
  if(this.#nativeCanAttach||this.#printApi instanceof ProductPrintApi)throw new ApiError(409,'Printer is owned by the native controller');
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
  if(this.#nativeCanAttach||this.#printApi instanceof ProductPrintApi)throw new ApiError(409,'Printer is owned by the native controller');
  if(this.#stopping||this.#klippy||this.#supervisor||this.#reconnecting)throw new Error('Klippy connection already owned or server stopping');
  const supervisor=new KlippySupervisor(async()=>{if(this.#klippy)await this.#reconnectKlippy();else await this.#attachKlippy(path,options);return this.#klippy!.signal;},()=>this.#klippy?.close()??Promise.resolve(),retryDelayMs);
  this.#supervisor=supervisor;supervisor.start();
 }
 get databaseRestoreStatus(){return {...this.#databaseRestart,state:this.#database?.status.restoreState??null};}
 requireConfigWriteIdle():void{if(this.#configFiles?.status.writing)throw new ApiError(409,'Configuration save is pending');}
 #beginConfigWrite(context:RpcContext):{release:()=>void;signal:AbortSignal}{
  if(this.#stopping||this.#nativeReattaching||this.#configHostControl?.status.busy)throw new ApiError(409,'Host transition blocks configuration save');
  if(!this.#nativeScope||context.nativeGenerationSignal&&context.nativeGenerationSignal!==this.#nativeScope.signal)throw new ApiError(503,'Configuration request belongs to another generation');
  if(this.#nativeRetirement){
   if(!context.nativeGenerationRetiredAtAdmission||!this.#nativeRetirementDrained||this.#nativeRetiredSnapshot?.hardware_state!=='stopped')throw new ApiError(409,'Printer stop is not confirmed');
   return {release:()=>{},signal:this.#startupAbort.signal};
  }
  this.#requireDatabaseIdle();let release:()=>void;try{release=this.maintenanceGate.acquire();}catch{throw new ApiError(409,'Printer activity blocks configuration save');}
  return {release,signal:this.#nativeScope.signal};
 }
 #requireDatabaseIdle(){
  if(this.#stopping)throw new ApiError(503,'Server is stopping');
  if(this.#printApi instanceof ProductPrintApi){
   // The caller already holds the shared gate. Its controller probe checks
   // active actions, journal writes, restoration and latched faults as well.
   const status=this.#printApi.status;
   if(status.closed)throw new ApiError(503,'Native printer is closed');
   if(!['idle','completed','cancelled'].includes(status.state)||status.pending_device_actions||status.safe_stop_pending)throw new ApiError(409,'Native printer is not idle for database maintenance');
   return;
  }
  const runtime=this.#klippy;if(!runtime?.snapshot.connected||!runtime.snapshot.initialized||runtime.snapshot.state!=='ready')throw new ApiError(503,'Printer state is unavailable for database maintenance');const state=runtime.cachedStatus.print_stats?.state;if(state==='printing'||state==='paused')throw new ApiError(409,'Database maintenance is unavailable while printing or paused');if(!['standby','complete','cancelled','error'].includes(state as string))throw new ApiError(503,'Print state is unavailable for database maintenance');
 }
 get klippySupervisor(){return this.#supervisor?.status??null;}
 get printControlStatus(){return this.#printApi?.status??{mode:'native',state:'unavailable',closed:true};}
 get nativeGenerationStatus(){return this.#nativeScope?{...this.#nativeScope.status,generation:this.#nativeGeneration,attaching:this.#nativeReattaching,drained:this.#nativeRetirementDrained,detached:!!this.#nativeRetirement,state:this.#nativeRetiredSnapshot?.hardware_state??'attached'}:null;}
 /** Trusted host composition only; never exposed in API payloads. */
 get nativeGenerationSignal(){return this.#nativeScope?.signal;}
 get nativeSubscriptionStatus(){return this.#nativeSubscriptions?.metrics??null;}
 /** Called only by the physical owner after its device cleanup has settled. */
 confirmNativeRetirement(outcome:'stopped'|'failed'):void{
  if(!this.#nativeRetiredSnapshot||!this.#nativeRetirementDrained||this.#nativeScope?.status.pending||!['stopped','failed'].includes(outcome))throw new Error('Native retirement is not drained');
  this.#nativeRetiredSnapshot={...this.#nativeRetiredSnapshot,group_state:outcome,hardware_state:outcome};
 }
 /** A failed device attempt has settled. The host alone decides whether its
  * cleanup is confirmed; failed cleanup must never reuse a stopped snapshot. */
 recordNativeStartupFailure(cleanupFailed:boolean,failure:NativeHostSnapshot['startup_failure']='device_startup_failed'):void{
  if(!this.#nativeRetiredSnapshot||!this.#nativeRetirementDrained)throw new Error('Native startup failure requires a drained detached owner');
  this.#nativeRetiredSnapshot={...this.#nativeRetiredSnapshot,startup_failure:cleanupFailed?'cleanup_unconfirmed':failure,...cleanupFailed?{group_state:'failed',hardware_state:'failed'}:{}};
 }
 /** Retire the device-facing owners while retaining listener, authentication,
  * database and process telemetry. Caller must also retire the physical printer
  * before releasing its profile. Reattachment is a separate lifecycle step. */
 retireNativePrinter():Promise<void>{
  if(this.#nativeRetirement)return this.#nativeRetirement;
  if(!(this.#printApi instanceof ProductPrintApi)||!this.#nativeScope)return Promise.reject(new Error('Native printer is not attached'));
  const done=Promise.withResolvers<void>();this.#nativeRetirement=done.promise;
  this.#nativeRetiredSnapshot={group_state:'stopping',hardware_state:'stopping',print_state:this.#printApi.status.state,homed_axes:'',closing:true,admission_closed:true,maintenance:false,mcus:[]};
  this.#nativeHost=undefined;this.#nativeController=undefined;this.maintenanceGate.invalidate();this.#nativeScope.retire();
  this.#nativeLifecycle?.sample();this.#nativeLifecycle?.close();
  this.#subscriptions?.close();this.#nativeSubscriptions?.close();this.#subscriptions=undefined;this.#nativeSubscriptions=undefined;
  this.#nativeTemperatureObjects=undefined;this.#temperatureStore?.detachNative();
  if(!this.#nativeProcessHistory)this.#nativeHistory?.();if(!this.#nativeProcessFiles)this.#releaseFileChanges();
  const tasks:(()=>void|Promise<void>)[]=[()=>this.#printApi!.close(),()=>this.#nativeUploads?.drain(),()=>this.#configFiles?.drainWrites(),()=>this.#nativeScope!.drain(),()=>this.#nativeProcessHistory?undefined:this.#nativeHistory?.drain(),()=>this.#printStateTask];
  void Promise.allSettled(tasks.map(task=>Promise.resolve().then(task))).then(results=>{
   const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
   this.#nativeRetiredSnapshot={...this.#nativeRetiredSnapshot!,...(errors.length?{group_state:'failed' as const,hardware_state:'failed' as const}:{}),print_state:(this.#printApi as ProductPrintApi).status.state};
   this.#nativeRetirementDrained=true;
   if(errors.length)done.reject(new AggregateError(errors,'Native API retirement failed'));else done.resolve();
  });return done.promise;
 }
 #registerDetachedNativeRoutes():()=>void{
  const releases:(()=>void)[]=[];const unavailable=()=>{throw new ApiError(503,'Native printer has not started');};
  try{
   for(const action of ['start','pause','resume','cancel','reset','status','pressure_advance'])releases.push(this.endpoints.register({endpoint:'/printer/print/'+action,methods:[action==='status'?'GET':'POST']},unavailable));
   releases.push(this.endpoints.register({endpoint:'/printer/emergency_stop',methods:['POST']},unavailable));
   for(const action of ['list','query','subscribe'])releases.push(this.endpoints.register({endpoint:'objects/'+action,methods:['GET','POST'],remote:true},unavailable));
   if(!this.#nativeProcessFiles)releases.push(this.endpoints.register({endpoint:'/server/files/delete_file',methods:['DELETE']},unavailable));
  }catch(error){for(const release of releases.reverse())release();throw error;}return ()=>{for(const release of releases.splice(0).reverse())release();};
 }
 #releaseNativeBindings():void{for(const release of this.#nativeReleases.splice(0).reverse())release();if(!this.#nativeProcessFiles)this.#releaseFileChanges=()=>{};}
 /** Reusing this listener cannot change its process-owned components or identity.
  * Compare resource/callback identity, not opaque objects' private fields. */
 assertNativeReuse(filename:string,options:ConfiguredServerOptions|ConfiguredAuthorizationOptions):void{
  const previous=this.#nativeProcessOptions,next=nativeProcessOptions(options);
  if(!this.#nativeCanAttach||this.#stopping||this.status.phase!=='listening'||filename!==this.#configurationPath||!previous||Object.keys(previous).length!==Object.keys(next).length)throw new ConfigurationError('Native process configuration cannot change');
  if(!sameProcessValue(previous,next))throw new ConfigurationError('Native process component identity cannot change');
 }
 /** Trusted composition handoff, not a remote restart command. Rejected input
  * remains caller-owned; ownership transfers after ProductPrintApi accepts it. */
 async attachNativePrinter(binding:NativePrinterBinding,prepare?:()=>void):Promise<void>{
  if(!this.#nativeCanAttach||this.#stopping||this.status.phase!=='listening'||this.#nativeReattaching||!this.#nativeRetirement)throw new ApiError(409,'Native printer is not ready for attachment');
  this.#nativeReattaching=true;const retirement=this.#nativeRetirement;
  try{
   await retirement;await this.#configFiles?.drainWrites();
   if(this.#stopping||this.#nativeRetirement!==retirement||this.#nativeRetiredSnapshot?.hardware_state!=='stopped'||this.maintenanceGate.status.activities||this.maintenanceGate.status.maintenance)throw new ApiError(409,'Native printer retirement is not confirmed');
   const {controller,gate,host,objects,uploads}=binding;if(prepare!==undefined&&typeof prepare!=='function')throw new ApiError(400,'Invalid native route preparation');
   if(!(controller instanceof PrintController)||!(gate instanceof MaintenanceGate)||gate===this.maintenanceGate||gate.status.closed||gate.status.activities||gate.status.maintenance||!(objects instanceof NativeObjects)||typeof host!=='function'||!['idle','interrupted'].includes(controller.state)||controller.pendingDeviceActions||controller.safeStopPending)throw new ApiError(400,'Invalid fresh native printer binding');
   const status=readNativeHostStatus(host);
   if(status.group_state!=='ready'||status.hardware_state!=='ready'||status.closing||status.admission_closed||status.maintenance||!status.mcus.length||status.mcus.some(m=>m.state!=='ready')||status.print_state!==controller.state)throw new ApiError(409,'New native hardware is not ready');
   if(uploads!==undefined&&(!(uploads instanceof NativePrintUploads)||!uploads.usesGate(gate)||!uploads.acceptsController(controller)||uploads.status.closed||uploads.status.pending||uploads.status.downloads||uploads.status.authorizing||(!uploads.metadataOwner&&uploads.status.metadata.pending)||uploadOwners.has(uploads)))throw new ApiError(400,'Invalid fresh native uploads');
   if(this.#nativeProcessFiles&&uploads?.metadataOwner!==this.#nativeProcessFiles||this.#nativeProcessHistory&&!controller.usesJournal(this.#nativeProcessHistory))throw new ApiError(400,'Native process resources cannot change');
   this.#startupAbort.signal.throwIfAborted();
   const api=new ProductPrintApi(controller,gate,binding.pressure,binding.compatibility),scope=new NativeRequestScope();
   this.#releaseNativeBindings();this.#nativeScope=scope;this.#printApi=api;this.#maintenanceGate=gate;this.#nativeHost=host;this.#nativeUploads=uploads;this.#nativeGeneration++;
   this.#nativeRetirement=undefined;this.#nativeRetirementDrained=false;if(!this.#nativeProcessHistory)this.#nativeHistory=undefined;this.#nativeController=controller;
   try{
    uploads?.bindPrintController(controller);if(uploads)uploadOwners.add(uploads);
    this.#nativeReleases.push(registerProductPrintApi(this.endpoints,api));this.#nativeReleases.push(registerNativeObjects(this.endpoints,objects));
    const owner=new NativeSubscriptions(objects,{deliver:(id,value,time)=>delivery.deliver(id,value,time),disconnect:id=>this.#network.disconnectClient(id)});
    const delivery=new SubscriptionDelivery({signal:id=>this.#network.connectionSignal(id),subscribe:(id,value,signal)=>owner.subscribe(id,value,signal),remove:id=>owner.remove(id),send:(id,value,time)=>this.#network.dispatchNotification(id,'notify_status_update',[value as Json,time],scope.signal),disconnect:id=>this.#network.disconnectClient(id),enabled:()=>!!this.#network.status.notifications});
    this.#nativeSubscriptions=owner;this.#subscriptions=delivery;
    this.#nativeReleases.push(this.endpoints.register({endpoint:'objects/subscribe',methods:['GET','POST'],remote:true,transports:['websocket','http']},(params,_verb,context)=>delivery.subscribe(params,context)));
    if(uploads){
     this.#nativeReleases.push(registerNativeFileInfo(this.endpoints,uploads,{metadata:!this.#metadataFiles,readRoutes:!this.#nativeProcessFiles,deleteRoute:!this.#nativeProcessFiles}));
     if(!this.#nativeProcessHistory){this.#nativeHistory=registerNativeHistory(this.endpoints,controller,uploads,event=>{if(!this.#stopping)this.#broadcastTracked('notify_history_changed',[event],this.#historyNotifications);});this.#nativeReleases.push(this.#nativeHistory);}
     if(!this.#nativeProcessFiles){this.#releaseFileChanges=uploads.observeChanges(event=>this.#broadcastTracked('notify_filelist_changed',[event],this.#fileNotifications));this.#nativeReleases.push(this.#releaseFileChanges);}
    }
    // Product-specific routes register synchronously before readiness publication.
    prepare?.();
    this.#nativeTemperatureObjects=objects;this.#temperatureStore!.readyNative(objects);
    this.#startupAbort.signal.throwIfAborted();const fresh=readNativeHostStatus(host);scope.signal.throwIfAborted();
    if(gate.status.closed||gate.status.activities||gate.status.maintenance||fresh.group_state!=='ready'||fresh.hardware_state!=='ready'||fresh.closing||fresh.admission_closed||fresh.maintenance||fresh.mcus.some(m=>m.state!=='ready')||fresh.print_state!==controller.state||!['idle','interrupted'].includes(controller.state)||controller.pendingDeviceActions||controller.safeStopPending)throw new ApiError(409,'New native hardware changed during attachment');
    this.#network.replaceNativeUploads(this.#nativeProcessFiles??uploads,scope.signal);if(this.#nativeProcessFiles)this.#nativeProcessFiles.bindDeviceFiles(uploads!,scope.signal);
    if(this.#nativeLifecycleEnabled)this.#nativeLifecycle=new NativeHostNotifications(()=>this.#nativeRetiredSnapshot??this.#nativeHost!(),method=>this.#broadcastTracked(method,[],this.#klippyNotifications));
    this.#nativeRetiredSnapshot=undefined;
    this.#printStateTask=this.#observePrintState(api,api.watchState(this.#startupAbort.signal));this.#nativeLifecycle?.start();
   }catch(error){
    try{await this.retireNativePrinter();}catch(cleanup){throw new AggregateError([error,cleanup],'Native attachment and cleanup failed');}throw error;
   }
  }finally{this.#nativeReattaching=false;}
 }
 get printNotifications(){return {...this.#printNotifications};}
 get fileNotifications(){return {...this.#fileNotifications};}
 get mqttRpcStatus(){return this.#mqttRpc?.status??null;}
 get mqttStatus(){return this.#mqttStatus?.status??null;}
 get mqttMacroStatus(){return this.#mqttMacros?.status??null;}
 get sensorTransportStatus(){return this.#sensorTransport?.status??null;}
 get sensorStatus(){return this.#sensors?{...this.#sensors.status,samples:this.#sensorSamples,error:this.#sensorError,notifications:{...this.#sensorNotifications}}:null;}
 get historyStatus(){return this.#historyRuntime?{...this.#historyRuntime.status,notifications:{...this.#historyNotifications}}:null;}
 get nativeHistoryStatus(){return this.#nativeHistory?{...this.#nativeHistory.status(),notifications:{...this.#historyNotifications}}:null;}
 async drainHistory():Promise<void>{await this.#historyRuntime?.drain();}
 get jobState(){return this.#jobState?{stats:this.#jobState.lastStats,event:this.#jobState.lastEvent}:null;}
 get cachedKlippyStatus(){return this.#klippy?.cachedStatus??null;}
 /** Only a retired sampler may hand history to the next service generation. */
 retiredTemperatureHistory():TemperatureStore|undefined{if(this.#temperatureStore&&!this.#temperatureStore.status.closed)throw new Error('Temperature sampler is still active');return this.#temperatureStore?.store;}
 get temperatureStoreStatus(){return this.#temperatureStore?.status??null;}
 /** Trusted native dispatch output; never a network command admission path. */
 recordNativeGcodeResponse(response:string):void{
  if(!(this.#printApi instanceof ProductPrintApi))throw new Error('Native G-code output requires a native print owner');
  if(this.#stopping||this.#nativeScope?.signal.aborted)return;
  this.#gcodeStore?.record(response,'response');this.#broadcastGcode(response);
 }
 get systemInformationStatus(){return this.#systemInformation?.status??null;}
 get procStatsStatus(){return this.#procStats?.status??null;}
 get gcodeStoreStatus(){return this.#gcodeStore?.status??null;}
 get gcodeNotifications(){return {...this.#gcodeNotifications};}
 get klippyNotifications(){return {...this.#klippyNotifications};}
 #broadcastGcode(response:string):void{
  this.#broadcastTracked('notify_gcode_response',[response],this.#gcodeNotifications);
 }
 async #observePrintState(api:ProductPrintApi,stream:ReturnType<ProductPrintApi['watchState']>):Promise<void>{
  let lastToken:string|undefined;
  try{for await(const _change of stream){
   // Fanout/authorization runs in a later event-loop turn, after already queued
   // device safety microtasks. The stream coalesces intervening state changes.
   await new Promise<void>(resolve=>setImmediate(resolve));
   if(this.#stopping||this.#nativeScope?.signal.aborted)break;
   // Read after the transition stack has unwound (reset also clears request).
   // More than one transition can occur before delivery; expose only current state.
   this.#nativeLifecycle?.sample();
   const status=api.status;if(status.state_token===lastToken)continue;lastToken=status.state_token;
   this.#broadcastTracked('notify_print_state_changed',[{state:status.state,state_token:status.state_token,request_id:status.request?.request_id??null}],this.#printNotifications);
  }}catch{this.#printNotifications.rejected++;}finally{await stream.return?.();}
 }
 #broadcastTracked(method:string,params:readonly Json[],metrics:ReturnType<typeof notificationMetrics>):void{
  metrics.received++;if(this.#stopping||this.#network.status.phase!=='listening'||!this.#network.status.notifications){metrics.disabled++;return;}
  const consume=(report:DeliveryReport)=>{for(const key of ['sent','denied','closed','overflow','failed'] as const)metrics[key]+=report[key];};
  // Client output cannot hold the Klippy callback lane or stop a print.
  // The network owns bounded authorization/output work and waits for it on close.
  const processEvent=method==='notify_filelist_changed'&&!!this.#nativeProcessFiles||method==='notify_history_changed'&&!!this.#nativeProcessHistory;
  try{const result=this.#network.dispatchBroadcast(method,params,[],!processEvent&&nativeGenerationNotifications.has(method)?this.#nativeScope?.signal:undefined);if('then' in result)void result.then(consume,()=>{metrics.rejected++;});else consume(result);}catch{metrics.rejected++;}
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
  const current=this.#klippy?.snapshot,copy=structuredClone(current?{...snapshot,connected:current.connected,state:current.state,missingRequirements:current.missingRequirements}:snapshot);const faulted=this.#metadataMonitor?.status.phase==='faulted';this.#information.replace({...copy,directories:[...new Set([...copy.directories,...this.#nativeProcessFiles||this.#nativeUploads?['gcodes']:[],...this.#configFiles?['config']:[]])],components:[...new Set([...copy.components,...this.#authorization?['authorization']:[],...this.#webcams?['webcam']:[],...this.#procStats?['proc_stats']:[],...this.#nativeHistory||this.#historyRuntime?['history']:[],...this.#metadataMonitor?['metadata_monitor']:[]])],failedComponents:[...new Set([...copy.failedComponents,...faulted?['metadata_monitor']:[],...this.#historyRuntime?.status.failure?['history']:[],...this.#sensorError?['sensor']:[]])],warnings:[...new Set([...copy.warnings,...this.#historyRuntime?.status.failure?['History persistence failed; tracking requires restart']:[],...this.#sensorError?['Sensor sampling failed; restart required']:[],...faulted?['File metadata monitoring failed; cached file metadata is unavailable']:[],...this.reader.warnings(),...this.klippyRemoteMethodFailures.map(f=>`Klippy remote method registration failed: ${f.name}`)])]});this.#base=copy;
 }
 start():Promise<AddressInfo>{
  if(this.#stopping)return Promise.reject(new Error('Configured server is stopping'));
  if(this.#opening)return this.#opening;
  this.#opening=this.#start();return this.#opening;
 }
 async #start():Promise<AddressInfo>{
  try{
   await this.#webcams?.start();
   if(this.#startupAbort.signal.aborted)throw new Error('Configured server startup cancelled',{cause:this.#startupAbort.signal.reason});
   this.reader.validate();this.reader.publish(this.#configuration);this.setInformation(this.#base);
   if(this.#metadataFiles)this.#metadataRecovery=await this.#metadataFiles.restoreSelected(this.#startupAbort.signal);
   if(this.#metadataMonitor)await this.#metadataMonitor.start();else if(this.#discoverMetadata)this.#metadataDiscovery=await this.#metadataFiles!.scanDiscovered(this.#startupAbort.signal);
   this.#startupAbort.signal.throwIfAborted();
   if(this.#database)await this.#database.sealTableRegistration();
   this.#startupAbort.signal.throwIfAborted();
   if(this.#sensorTransport)await this.#sensorTransport.start();
   this.#startupAbort.signal.throwIfAborted();
   if(this.#nativeTemperatureObjects)this.#temperatureStore!.readyNative(this.#nativeTemperatureObjects);
   await this.#systemInformation?.start();this.#startupAbort.signal.throwIfAborted();
   const address=await this.#network.listen(this.binding.port,this.binding.host);
   this.#startupAbort.signal.throwIfAborted();
   this.#nativeLifecycle?.start();this.#procStats?.start();
   if(this.#printApi instanceof ProductPrintApi)this.#printStateTask=this.#observePrintState(this.#printApi,this.#printApi.watchState(this.#startupAbort.signal));
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
  this.#nativeScope?.retire();
  this.#nativeLifecycle?.close();this.#nativeHistory?.();this.#releaseFileChanges();
  this.#stopping=true;this.maintenanceGate.invalidate();clearInterval(this.#sensorTimer);this.#sensorTimer=undefined;const mqttRpcClosed=this.#mqttRpc?.close()??Promise.resolve();const mqttStatusClosed=this.#mqttStatus?.close()??Promise.resolve();const mqttMacrosClosed=this.#mqttMacros?.close()??Promise.resolve();const sensorTransportClosed=this.#sensorTransport?.close()??Promise.resolve();this.#sensors?.close();const printClosed=Promise.resolve(this.#printApi?.close());this.#startupAbort.abort(new Error('Configured server is stopping'));this.#subscriptions?.close();this.#nativeSubscriptions?.close();const historyClosed=this.#historyRuntime?.close(this.#jobState?.lastStats??{})??Promise.resolve();const networkClosed=this.#network.close();const authorizationClosed=networkClosed.then(()=>this.#authorization?.close(),async error=>{try{await this.#authorization?.close();}catch(cleanup){throw new AggregateError([error,cleanup],'Network and authorization cleanup failed');}throw error;});const webcamsClosed=networkClosed.then(()=>this.#webcams?.close(),()=>this.#webcams?.close());const nativeClosed=Promise.allSettled([this.#nativeUploads?.drain(),this.#nativeProcessFiles?.drain(),this.#nativeScope?.drain(),this.#nativeHistory?.drain()]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Native dependencies failed to drain');});const databaseClosed=Promise.allSettled([historyClosed,authorizationClosed,webcamsClosed,nativeClosed]).then(()=>this.#database?.close());const settled=await Promise.allSettled([nativeClosed,printClosed,this.#printStateTask,mqttRpcClosed,mqttStatusClosed,mqttMacrosClosed,sensorTransportClosed,historyClosed,authorizationClosed,webcamsClosed,databaseClosed,this.#systemInformation?.close(),this.#procStats?.close(),this.#temperatureStore?.close(),this.#supervisor?.stop(),this.#klippy?.close(),this.#metadataMonitor?.close(),this.#metadataFiles?.close(),networkClosed.then(()=>this.#configFiles?.close(),()=>this.#configFiles?.close())]);const errors=settled.filter(value=>value.status==='rejected').map(value=>value.reason);if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Configured server cleanup failed');for(const release of this.#klippyRoutes.values())release();this.#klippyRoutes.clear();this.#releaseAuthorization();this.#release();if(this.#metadataFiles)fileOwners.delete(this.#metadataFiles);if(this.#database)databaseOwners.delete(this.#database);if(this.#configFiles)configFileOwners.delete(this.#configFiles);
 }
}
