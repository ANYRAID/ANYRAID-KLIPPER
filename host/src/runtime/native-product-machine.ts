import {isAbsolute,relative,resolve,sep,dirname,basename} from 'node:path';
import {realpath} from 'node:fs/promises';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {NativePrintUploads,type NativeUploadOptions} from '../moonraker/native-print-uploads.ts';
import {NativeUfpDiskImports,type NativeUfpDiskImportOptions} from '../moonraker/native-ufp-disk-imports.ts';
import {ServerInformation} from '../moonraker/metadata.ts';
import {assertProductAuthorization} from './product-authorization.ts';
import {ApiError} from '../moonraker/rpc.ts';
import {nativeFilename} from '../moonraker/native-file-path.ts';
import type {ProductMachineConfiguration} from '../config/product-machine.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {loadProductMachineProfile,readProductMachine,type ProductMachineBindings} from './product-machine-profile.ts';
import type {ProductHostFactory,ProductHostProfile,HostReloadContext} from './product-host.ts';
import {PrintJournal} from '../operations/print-journal.ts';
import {ConfiguredMoonraker} from '../moonraker/configured-server.ts';
import {resetConfiguredFirmware} from './firmware-restart.ts';
import {NativeConfigFiles,type NativeConfigFilesOptions} from '../moonraker/native-config-files.ts';
import type {MachineControlPort} from '../moonraker/machine-control.ts';

type NativeAdapterServer<T>=T extends unknown?Omit<T,'nativeUploads'|'productPrintCompatibility'|'nativeProcessFiles'|'nativeProcessHistory'|'configFiles'>:never;
export interface NativeMachineAdapter {
 stops:ProductMachineBindings['stops'];
 lifecycle:ProductMachineBindings['print']['lifecycle'];
 output:ProductMachineBindings['print']['output'];
 /** Source admission policy in addition to RPC authorization. Must not move or heat. */
 authorizePrintFile(fileId:string,signal:AbortSignal):Promise<void>;
 server:NativeAdapterServer<ProductMachineBindings['server']>;
 /** Adapter owns its own partial failure; a successful factory return transfers ownership. */
 release():Promise<void>;
}
export interface NativeProductMachineOptions {
 filesRoot:string;metadataRoot:string;
 files?:Parameters<typeof PublishedPrintFiles.open>[1];
 uploads?:NativeUploadOptions;
 /** Explicit config subtree; only process-mode factories may expose it. */
 configFiles?:NativeConfigFilesOptions;
 /** Separate service-owned filesystem inbox; requires process lifetime. */
 diskImports?:Pick<NativeUfpDiskImportOptions,'root'|'maxClaims'|'maxClaimBytes'>;
 /** Borrowed process storage. A profile closes its admission/metadata layer,
  * releases its lease and adapter, but cannot close the file store. */
 fileResources?:NativeProductFileResources;
 processFiles?:NativePrintUploads;
 /** Explicit preparation temperatures for filename-only client requests. No file macro inference. */
 standardPrint?:{nozzle:number;bed:number};
 createAdapter(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate):Promise<NativeMachineAdapter>;
}
export interface NativeProductProcessResources {
 server:NativeMachineAdapter['server'];
 /** Explicit current local filesystem policy from this process owner. */
 diskImportContext?:NativeUfpDiskImportOptions['context'];
 /** Optional writable capability; host owns final cancellation and joins. */
 machineControl?:MachineControlPort;
 /** Runs after final server closure, or failed pre-server startup. Managed
  * server components have transferred to the server; release other resources
  * and close any components that never transferred. Must be idempotent. */
 release():Promise<void>;
}
export interface NativeProductProcessOptions extends Omit<NativeProductMachineOptions,'fileResources'|'processFiles'|'createAdapter'> {
 createProcess(configuration:ProductMachineConfiguration,signal:AbortSignal):Promise<NativeProductProcessResources>;
 /** Device resources only. Returning a server would mix the two lifetimes. */
 createAdapter(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate,process:Readonly<NativeMachineAdapter['server']>,reload?:HostReloadContext):Promise<Omit<NativeMachineAdapter,'server'>>;
}
function overlapping(a:string,b:string):boolean {const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
async function plannedPath(input:string):Promise<string>{let current=resolve(input);const suffix:string[]=[];for(let depth=0;depth<128;depth++){try{return resolve(await realpath(current),...suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(current);if(parent===current)throw error;suffix.unshift(basename(current));current=parent;}}throw new Error('Storage path depth exceeded');}
function storageRoots(options:Pick<NativeProductMachineOptions,'filesRoot'|'metadataRoot'>){
 for(const path of [options.filesRoot,options.metadataRoot])if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/u.test(path))throw new TypeError('Native product storage requires absolute paths');
 const filesRoot=resolve(options.filesRoot),metadataRoot=resolve(options.metadataRoot);
 if(overlapping(filesRoot,metadataRoot)||overlapping(metadataRoot,filesRoot))throw new TypeError('Native file and metadata roots must be separate');
 return {filesRoot,metadataRoot};
}
/** One locked file store per process. Generation leases are exclusive: old
 * callbacks must drain before a fresh admission layer can use the store. */
export class NativeProductFileResources {
 readonly #files:PublishedPrintFiles;readonly #filesRoot:string;readonly #metadataRoot:string;
 #lease:ReturnType<typeof Promise.withResolvers<void>>|undefined;#closed=false;#closing:Promise<void>|undefined;
 #processFiles:NativePrintUploads|undefined;#openingFiles:Promise<NativePrintUploads>|undefined;
 #diskImports:NativeUfpDiskImports|undefined;#openingImports:Promise<NativeUfpDiskImports>|undefined;
 #retirementFailed=false;#offlineOperations=0;readonly #offlineIds=new Set<string>();
 #beginOfflineMutation(ids:readonly string[]):()=>void{
  if(this.#closed||this.#lease||this.#retirementFailed||this.#offlineOperations>=4)throw new Error('Offline file mutation unavailable');
  if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)||this.#offlineIds.has(id)))throw new Error('Invalid or owned offline file identity');
  const captured=[...ids];for(const id of captured)this.#offlineIds.add(id);this.#offlineOperations++;let released=false;
  return ()=>{if(!released){released=true;for(const id of captured)this.#offlineIds.delete(id);this.#offlineOperations--;}};
 }
 async processFiles(options:NativeUploadOptions):Promise<NativePrintUploads>{
  if(this.#closed)throw new Error('Native process files closed');
  const resources=this;
  this.#openingFiles??=NativePrintUploads.open(this.#files,new MaintenanceGate(),{...options,metadataRoot:this.#metadataRoot}).then(owner=>{
   owner.bindOfflineFileMutations({get available(){return !resources.#closed&&!resources.#lease&&!resources.#retirementFailed;},beginFileMutations:ids=>resources.#beginOfflineMutation(ids)});
   return this.#processFiles=owner;
  });return this.#openingFiles;
 }
 async startDiskImports(options:NativeUfpDiskImportOptions):Promise<NativeUfpDiskImports>{
  if(this.#closed||!this.#processFiles)throw new Error('Disk imports require open process files');
  const root=await plannedPath(options.root),storage=await Promise.all([this.#filesRoot,this.#metadataRoot].map(plannedPath));if(storage.some(path=>overlapping(root,path)||overlapping(path,root)))throw new Error('Disk inbox must be separate from file and metadata stores');
  return this.#openingImports??=NativeUfpDiskImports.open(this.#processFiles,this.#files,{...options}).then(owner=>this.#diskImports=owner);
 }
 private constructor(files:PublishedPrintFiles,filesRoot:string,metadataRoot:string){this.#files=files;this.#filesRoot=filesRoot;this.#metadataRoot=metadataRoot;}
 static async open(options:Pick<NativeProductMachineOptions,'filesRoot'|'metadataRoot'|'files'>):Promise<NativeProductFileResources>{
  const {filesRoot,metadataRoot}=storageRoots(options),files=await PublishedPrintFiles.open(filesRoot,{...options.files});
  return new NativeProductFileResources(files,filesRoot,metadataRoot);
 }
 get status(){return {closing:this.#closed,leased:!!this.#lease,retirementFailed:this.#retirementFailed,offlineMutations:this.#offlineOperations,files:this.#files.status,diskImports:this.#diskImports?.status};}
 acquire(options:Pick<NativeProductMachineOptions,'filesRoot'|'metadataRoot'>):{files:PublishedPrintFiles;release:(confirmed?:boolean)=>void}{
  const roots=storageRoots(options);
  if(roots.filesRoot!==this.#filesRoot||roots.metadataRoot!==this.#metadataRoot)throw new Error('Native process storage identity cannot change');
  if(this.#closed||this.#files.status.closed)throw new Error('Native process files closed');
  if(this.#lease)throw new Error('Previous native file generation has not retired');
  if(this.#retirementFailed||this.#offlineOperations)throw new Error('Native process files are not available for device attachment');
  const lease=Promise.withResolvers<void>();this.#lease=lease;
  return {files:this.#files,release:(confirmed=true)=>{if(this.#lease===lease){if(!confirmed)this.#retirementFailed=true;this.#lease=undefined;lease.resolve();}}};
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  this.#closing=(async()=>{await this.#lease?.promise;await this.#openingImports?.catch(()=>{});const results=await Promise.allSettled([this.#diskImports?.close()]);await this.#openingFiles?.catch(()=>{});try{await this.#processFiles?.drain();}catch(error){results.push({status:'rejected',reason:error});}try{await this.#files.close();}catch(error){results.push({status:'rejected',reason:error});}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Native process files cleanup failed');})();return this.#closing;
 }
}
/** Assemble native file/metadata ownership once for real machine profiles and
 * compiled acceptance. Caller retires all printer/server owners before release. */
export async function createNativeProductBindings(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate,options:NativeProductMachineOptions):Promise<ProductMachineBindings>{
 signal.throwIfAborted();
 if(!(gate instanceof MaintenanceGate)||gate.status.closed||typeof options.createAdapter!=='function')throw new TypeError('Open gate and native machine adapter factory are required');
 const {filesRoot,metadataRoot}=storageRoots(options),resources=options.fileResources;
 if(resources!==undefined&&(!(resources instanceof NativeProductFileResources)||options.files!==undefined))throw new TypeError('Native process file resources cannot override file options');
 const config=structuredClone(configuration),ids=Object.keys(config.mcus),filesOptions={...options.files},uploadOptions={...options.uploads},standard=options.standardPrint?{nozzle:options.standardPrint.nozzle,bed:options.standardPrint.bed}:undefined,createAdapter=options.createAdapter;
 if(standard&&(!Number.isFinite(standard.nozzle)||standard.nozzle<0||standard.nozzle>config.limits.maxNozzle||!Number.isFinite(standard.bed)||standard.bed<0||standard.bed>config.limits.maxBed))throw new TypeError('Standard print temperatures exceed machine limits');
 let adapter:NativeMachineAdapter|undefined,files:PublishedPrintFiles|undefined,uploads:NativePrintUploads|undefined,closing:Promise<void>|undefined,fileLease:{files:PublishedPrintFiles;release:(confirmed?:boolean)=>void}|undefined;
 const stopped=new AbortController(),pending=new Set<Promise<unknown>>();
 const track=<T>(work:()=>Promise<T>):Promise<T>=>{if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);if(pending.size>=8)return Promise.reject(new ApiError(429,'Native file admission capacity exceeded'));const task=Promise.resolve().then(work);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;};
 const release=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;stopped.abort(new Error('Native machine bindings closed'));
  void (async()=>{await Promise.allSettled([...pending]);const errors:unknown[]=[];for(const close of [()=>uploads?.drain(),()=>resources?undefined:files?.close(),()=>adapter?.release()])try{await close();}catch(error){errors.push(error);}fileLease?.release(errors.length===0);if(errors.length)throw new AggregateError(errors,'Native machine bindings cleanup failed');})().then(done.resolve,done.reject);return closing;
 };
 try{
  fileLease=resources?.acquire({filesRoot,metadataRoot});
  adapter=await createAdapter(structuredClone(config),signal,gate);signal.throwIfAborted();
  if(!adapter||typeof adapter.release!=='function'||typeof adapter.output!=='function'||typeof adapter.authorizePrintFile!=='function'||!adapter.stops||adapter.stops.size!==ids.length||ids.some(id=>typeof adapter!.stops.get(id)!=='function'))throw new TypeError('Incomplete native machine adapter');
  assertProductAuthorization(adapter.server,true);
  for(const key of ['prepare','start','finishOutputs','stopOutputs'] as const)if(typeof adapter.lifecycle?.[key]!=='function')throw new TypeError('Incomplete native machine output lifecycle');
  if('nativeUploads' in adapter.server||'productPrintCompatibility' in adapter.server)throw new TypeError('Native product owns file and standard print bindings');
  new ServerInformation(adapter.server.information);
  const authorize=adapter.authorizePrintFile.bind(adapter),output=adapter.output.bind(adapter),lifecycle={...adapter.lifecycle},stops=new Map(adapter.stops),server={...adapter.server,information:structuredClone(adapter.server.information)};
  files=fileLease?.files??await PublishedPrintFiles.open(filesRoot,filesOptions);signal.throwIfAborted();
  uploads=options.processFiles?new NativePrintUploads(files,gate,uploadOptions,options.processFiles):await NativePrintUploads.open(files,gate,{...uploadOptions,metadataRoot});signal.throwIfAborted();
  const ownedFiles=files,ownedUploads=uploads;
  const active=(incoming:AbortSignal)=>{const combined=AbortSignal.any([incoming,stopped.signal]);combined.throwIfAborted();if(gate.status.closed)throw new ApiError(503,'Machine admission closed');return combined;};
  const resolveFile=async(id:string,incoming:AbortSignal)=>{const s=active(incoming);if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new ApiError(400,'Invalid native file ID');await authorize(id,s);s.throwIfAborted();if(gate.status.closed)throw new ApiError(503,'Machine admission closed');return s;};
  return {stops,print:{lifecycle,output,open(id,incoming){return track(async()=>ownedFiles.acquire(id,await resolveFile(id,incoming)));}},server:{...server,nativeUploads:ownedUploads,...standard?{productPrintCompatibility:{start(filename,incoming){return track(async()=>{nativeFilename(filename);const initial=active(incoming);let fileId:string;try{fileId=await ownedFiles.resolvePath(filename,initial);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}const s=await resolveFile(fileId,incoming);try{if(await ownedFiles.resolvePath(filename,s)!==fileId)throw new ApiError(409,'Published path changed during authorization');await ownedFiles.describe(fileId,s);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}s.throwIfAborted();return {fileId,...standard};});}}}:{}},release};
 }catch(error){try{await release();}catch(cleanup){throw new AggregateError([error,cleanup],'Native machine assembly and cleanup failed',{cause:error});}throw error;}
}
export function loadNativeProductMachineProfile(path:string,options:NativeProductMachineOptions,signal:AbortSignal){
 return loadProductMachineProfile(path,(config,s,gate)=>createNativeProductBindings(config,s,gate,options),signal);
}
/** Product entry factory. createProcess selects one server/dependency lifetime
 * across device generations. Without it, legacy adapters retain their existing
 * one-generation server ownership while sharing only the file store. */
export function createNativeProductHostFactory(path:string,options:Omit<NativeProductMachineOptions,'fileResources'>|NativeProductProcessOptions):ProductHostFactory{
 if(typeof options.createAdapter!=='function')throw new TypeError('Native machine adapter factory is required');
 if('createProcess' in options&&typeof options.createProcess!=='function')throw new TypeError('Native process resource factory is required');
 if(options.configFiles&&!('createProcess' in options))throw new TypeError('Config files require process lifetime');
 if(options.diskImports&&!('createProcess' in options))throw new TypeError('Disk imports require process lifetime');
 storageRoots(options);
 if(options.diskImports){const root=options.diskImports.root;if(typeof root!=='string'||!isAbsolute(root)||/[\0\r\n]/u.test(root)||[options.filesRoot,options.metadataRoot].some(storage=>overlapping(resolve(root),resolve(storage))||overlapping(resolve(storage),resolve(root))))throw new TypeError('Disk inbox must be an absolute, separate storage root');}
 const snapshot={...options,diskImports:options.diskImports?structuredClone(options.diskImports):undefined,configFiles:options.configFiles?structuredClone(options.configFiles):undefined,files:{...options.files},uploads:{...options.uploads},standardPrint:options.standardPrint?{...options.standardPrint}:undefined},stopped=new AbortController();
 const processOptions='createProcess' in snapshot?snapshot:undefined;
 let processResources:NativeProductProcessResources|undefined,processOpening:Promise<void>|undefined,processJournal:PrintJournal|undefined,processIdentity:ProductMachineConfiguration|undefined;
 let configFiles:NativeConfigFiles|undefined;
 let bootstrapping:ReturnType<NonNullable<ProductHostFactory['bootstrap']>>|undefined;
 let resources:NativeProductFileResources|undefined,pending:Promise<ProductHostProfile>|undefined,active=false,closing:Promise<void>|undefined;
 const ensureProcess=async(config:ProductMachineConfiguration,s:AbortSignal)=>{
  if(processIdentity&&(['deviceId','journalPath','moonrakerConfig','printerConfig'] as const).some(key=>processIdentity![key]!==config[key]))throw new Error('Native process configuration identity cannot change');
  processIdentity??=structuredClone(config);
  resources??=await NativeProductFileResources.open(snapshot);s.throwIfAborted();
  processOpening??=(async()=>{
   processResources=await processOptions!.createProcess(structuredClone(config),s);s.throwIfAborted();
   if(!processResources||typeof processResources.release!=='function')throw new TypeError('Native process resources must own cleanup');
   if(snapshot.diskImports&&typeof processResources.diskImportContext!=='function')throw new TypeError('Disk imports require the current process filesystem policy');
   if(processResources.machineControl&&(['retirement','execute','assertDeviceAvailable','close'] as const).some(key=>typeof processResources!.machineControl![key]!=='function'))throw new TypeError('Invalid native machine control capability');
   assertProductAuthorization(processResources.server,true);new ServerInformation(processResources.server.information);
   if(['nativeDetached','productPrint','nativeHost','nativeObjects','maintenanceGate','nativeUploads','productPrintCompatibility','nativeProcessFiles','nativeProcessHistory','configFiles'].some(key=>key in processResources!.server))throw new TypeError('Native process resources cannot override native resource owners');
   if(snapshot.configFiles){configFiles=await NativeConfigFiles.open(snapshot.configFiles);if(!configFiles.contains(config.printerConfig))throw new TypeError('Printer config must be inside the explicit config root');s.throwIfAborted();}
   await resources!.processFiles(snapshot.uploads);s.throwIfAborted();
   processJournal=await PrintJournal.open({path:config.journalPath,deviceId:config.deviceId});s.throwIfAborted();
  })();await processOpening;s.throwIfAborted();
 };
 const factory:ProductHostFactory=(incoming,reload)=>{
  if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);
  if(active)return Promise.reject(new Error('Previous native profile has not retired'));
  incoming.throwIfAborted();active=true;const signal=AbortSignal.any([incoming,stopped.signal]);
  const task=loadProductMachineProfile(path,async(config,s,gate)=>{
   let createAdapter:NativeProductMachineOptions['createAdapter'];
   if(processOptions){
    await ensureProcess(config,s);
    createAdapter=async(c,signal,g)=>{
     const device=await processOptions.createAdapter(c,signal,g,processResources!.server,reload);
     if(device&&'server' in device){const error=new TypeError('Process-mode adapter must own only device resources');try{await device.release?.();}catch(cleanup){throw new AggregateError([error,cleanup],'Invalid native device cleanup failed');}throw error;}
     return {...device,server:processResources!.server};
    };
   }else{resources??=await NativeProductFileResources.open(snapshot);s.throwIfAborted();createAdapter=(snapshot as NativeProductMachineOptions).createAdapter;}
   const processFiles=processOptions?await resources!.processFiles(snapshot.uploads):undefined;s.throwIfAborted();
   const bindings=await createNativeProductBindings(config,s,gate,{...snapshot,createAdapter,files:undefined,fileResources:resources,processFiles});
   return processOptions?{...bindings,journal:processJournal,server:{...bindings.server,configFiles,nativeProcessFiles:processFiles,nativeProcessHistory:processJournal}}:bindings;
  },signal).then(profile=>{
   const release=profile.release;let retiring:Promise<void>|undefined;
   profile.release=()=>retiring??=(async()=>{try{await release();}finally{active=false;}})();return profile;
  },error=>{active=false;throw error;});
  pending=task;void task.then(()=>{if(pending===task)pending=undefined;},()=>{if(pending===task)pending=undefined;});return task;
 };
 factory.close=()=>{
  if(closing)return closing;stopped.abort(new Error('Native product factory closed'));
  closing=(async()=>{await pending?.catch(()=>{});await bootstrapping?.catch(()=>{});const results=await Promise.allSettled([resources?.close()]);await Promise.allSettled([processOpening]);for(const close of [()=>processResources?.machineControl?.close(),()=>configFiles?.close(),()=>processJournal?.close(),()=>processResources?.release?.()])try{await close();}catch(error){results.push({status:'rejected',reason:error});}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Native process cleanup failed');})();return closing;
 };
 if(processOptions){
  Object.defineProperty(factory,'serverLifetime',{value:'process',enumerable:true});
  Object.defineProperty(factory,'diskImportStatus',{get:()=>resources?.status.diskImports,enumerable:true});
  Object.defineProperty(factory,'machineControl',{get:()=>processResources?.machineControl,enumerable:true});
  factory.resetFirmware=(profile,signal)=>resetConfiguredFirmware(profile.reader,profile.policies,signal);
  factory.bootstrap=(incoming,control)=>{
   if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);incoming.throwIfAborted();
   if(active)return Promise.reject(new Error('Native process bootstrap must precede device acquisition'));
   return bootstrapping??=(async()=>{
    const signal=AbortSignal.any([incoming,stopped.signal]),config=await readProductMachine(path,signal);await ensureProcess(config,signal);
    const process=processResources!.server,files=await resources!.processFiles(snapshot.uploads);
    const serverOptions={nativeDetached:true as const,configFiles,nativeProcessFiles:files,nativeProcessHistory:processJournal!,productHostControl:control,
     nativePrinterIdentity:{configFile:config.printerConfig,softwareVersion:process.information.version},systemInformation:process.systemInformation??{},systemServices:process.systemServices??{},procStats:process.procStats??{},gcodeStore:process.gcodeStore??{},temperatureStore:{...process.temperatureStore,previous:undefined}};
    const server=process.authorization?await ConfiguredMoonraker.loadAuthorized(config.moonrakerConfig,{...process,...serverOptions}):await ConfiguredMoonraker.load(config.moonrakerConfig,{...process,...serverOptions});
    if(snapshot.diskImports)try{await resources!.startDiskImports({...snapshot.diskImports,context:signal=>processResources!.diskImportContext!(AbortSignal.any([signal,stopped.signal]))});}catch(error){await server.close();throw error;}
    return {server,recoveryJournal:{path:config.journalPath+'.host-recovery.sqlite',deviceId:config.deviceId}};
   })();
  };
 }

 return factory;
}
