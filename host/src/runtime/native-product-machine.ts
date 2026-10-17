import type {MachineDeviceGuard} from '../moonraker/none-machine-control.ts';
import {expandConfigurationUserPath,resolveConfigurationPath} from '../moonraker/config-path.ts';
import {ProcessLogs,validateProcessLogging,type ProcessLoggingOptions} from '../moonraker/process-logs.ts';
import {loadWelcomeSource} from '../moonraker/welcome-application.ts';
import {isAbsolute,relative,resolve,sep,dirname,basename} from 'node:path';
import {realpath,mkdir} from 'node:fs/promises';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {NativePrintUploads,type NativeUploadOptions} from '../moonraker/native-print-uploads.ts';
import {NativeUfpDiskImports,type NativeUfpDiskImportOptions} from '../moonraker/native-ufp-disk-imports.ts';
import {ServerInformation} from '../moonraker/metadata.ts';
import {readTlsConfiguration,selectTlsMaterialPaths} from '../moonraker/tls-configuration.ts';
import {selectSecretsMaterialPath} from '../moonraker/secrets.ts';
import type {ExternalNodeInstallationService} from '../moonraker/legacy-node-install.ts';
import {ConfigurationReader} from '../moonraker/config-reader.ts';
import {loadConfiguration,ConfigurationError} from '../moonraker/config-source.ts';
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
import {SystemdBusControl} from '../moonraker/systemd-bus-control.ts';
import {MachineSystemProvider,readMachineProvider,type MachineProviderOptions} from '../moonraker/machine-provider.ts';
import {LinuxMachineControl} from '../moonraker/machine-control.ts';
import type {FixedNodeInstallOptions} from '../moonraker/fixed-node-install.ts';
import type {SudoBackend} from '../moonraker/sudo-backend.ts';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DatabaseStore,resolveDatabaseStoreOptions,type DatabaseStoreOptions} from '../moonraker/database.ts';
import {LegacyProductPathOwner,validateLegacyProductPaths,type LegacyProductPaths} from './legacy-product-paths.ts';
import {prepareLegacyDatabase,validateLegacyDatabasePreopen,type LegacyDatabasePreopenOptions} from '../moonraker/legacy-database-preopen.ts';
import {prepareLegacyGcodes,type LegacyGcodeImportOptions,type LegacyGcodeImportReceipt} from './legacy-gcode-import.ts';

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
 /** Borrowed actual device guard; process release owns its lifetime. Not JSON configuration. */
 machineDeviceGuard?:MachineDeviceGuard;
 /** Runs after final server closure, or failed pre-server startup. Managed
  * server components have transferred to the server; release other resources
  * and close any components that never transferred. Must be idempotent. */
 release():Promise<void>;
}
export interface NativeProductProcessOptions extends Omit<NativeProductMachineOptions,'fileResources'|'processFiles'|'createAdapter'> {
 /** Trusted provider capabilities. Configuration cannot grant write scope. */
 machineProvider?:MachineProviderOptions;
 installation?:{options:FixedNodeInstallOptions;backend:SudoBackend;externalService?:ExternalNodeInstallationService;
  /** A failed primary component generation closes its backend. Only this
   * trusted factory may supply a fresh, uncached backend for the backup. */
  reopenBackend?:()=>SudoBackend;};
 /** Trusted offline migration before file/database/log/journal acquisition.
  * createProcess must use the supplied identity database. */
 legacyDatabase?:LegacyDatabasePreopenOptions;
 /** Approved logical aliases are published before any process resource opens.
  * Physical roots remain the only capabilities used by NOFOLLOW owners. */
 legacyPaths?:LegacyProductPaths;
 /** Ordinary-UID, quiescent old tree import into the owned publication store.
  * The original tree is retained and never used as a disk-import inbox. */
 legacyGcodes?:LegacyGcodeImportOptions;
 /** Trusted most-recent working source, used once on a primary configuration failure.
  * A backup process keeps installation and device acquisition blocked. */
 legacyConfiguration?:{backupFile:string};
 /** Existing trusted database budgets/backup capability. Path and original
  * identity declaration remain bound by legacyDatabase, never overridden. */
 legacyDatabaseOwnerOptions?:Omit<DatabaseStoreOptions,'path'|'legacyAuthorization'>;
 /** Explicit process data directory. Every process server owns one private
  * template/secrets generation; device restarts do not reload it. */
 dataPath:string;
 /** Explicit writable producer choices; old server log files stay borrowed. */
 logging?:ProcessLoggingOptions;
 createProcess(configuration:ProductMachineConfiguration,signal:AbortSignal,preopened?:{database:DatabaseStore;paths?:readonly {relative:string;physical:string;kind:'directory'|'file';dev:string;ino:string}[]}):Promise<NativeProductProcessResources>;
 /** Device resources only. Returning a server would mix the two lifetimes. */
 createAdapter(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate,process:Readonly<NativeMachineAdapter['server']>,reload?:HostReloadContext):Promise<Omit<NativeMachineAdapter,'server'>>;
}
function overlapping(a:string,b:string):boolean {const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
async function plannedPath(input:string):Promise<string>{let current=resolve(input);const suffix:string[]=[];for(let depth=0;depth<128;depth++){try{return resolve(await realpath(current),...suffix);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const parent=dirname(current);if(parent===current)throw error;suffix.unshift(basename(current));current=parent;}}throw new Error('Storage path depth exceeded');}
export {plannedPath as plannedProductStoragePath};
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
 readonly #stopped=new AbortController();#legacyOpening:Promise<LegacyGcodeImportReceipt>|undefined;#legacyIdentity:string|undefined;#legacyReady=false;
 #retirementFailed=false;#offlineOperations=0;readonly #offlineIds=new Set<string>();
 #beginOfflineMutation(ids:readonly string[]):()=>void{
  if(this.#closed||this.#lease||this.#retirementFailed||this.#legacyIdentity!==undefined&&!this.#legacyReady||this.#offlineOperations>=4)throw new Error('Offline file mutation unavailable');
  if(!Array.isArray(ids)||ids.length>10000||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id)||this.#offlineIds.has(id)))throw new Error('Invalid or owned offline file identity');
  const captured=[...ids];for(const id of captured)this.#offlineIds.add(id);this.#offlineOperations++;let released=false;
  return ()=>{if(!released){released=true;for(const id of captured)this.#offlineIds.delete(id);this.#offlineOperations--;}};
 }
 async processFiles(options:NativeUploadOptions):Promise<NativePrintUploads>{
  if(this.#closed||this.#legacyIdentity!==undefined&&!this.#legacyReady)throw new Error('Native process files closed or legacy publication unconfirmed');
  const resources=this;
  this.#openingFiles??=NativePrintUploads.open(this.#files,new MaintenanceGate(),{...options,metadataRoot:this.#metadataRoot}).then(owner=>{
   owner.bindOfflineFileMutations({get available(){return !resources.#closed&&!resources.#lease&&!resources.#retirementFailed&&(resources.#legacyIdentity===undefined||resources.#legacyReady);},beginFileMutations:ids=>resources.#beginOfflineMutation(ids)});
   return this.#processFiles=owner;
  });return this.#openingFiles;
 }
 async startDiskImports(options:NativeUfpDiskImportOptions):Promise<NativeUfpDiskImports>{
  if(this.#closed||!this.#processFiles||this.#legacyIdentity!==undefined&&!this.#legacyReady)throw new Error('Disk imports require confirmed, open process files');
  const root=await plannedPath(options.root),storage=await Promise.all([this.#filesRoot,this.#metadataRoot].map(plannedPath));if(storage.some(path=>overlapping(root,path)||overlapping(path,root)))throw new Error('Disk inbox must be separate from file and metadata stores');
  return this.#openingImports??=NativeUfpDiskImports.open(this.#processFiles,this.#files,{...options}).then(owner=>this.#diskImports=owner);
 }
 prepareLegacyGcodes(options:LegacyGcodeImportOptions,signal:AbortSignal):Promise<LegacyGcodeImportReceipt>{
  if(this.#closed||this.#lease||this.#offlineOperations)throw new Error('Legacy import requires detached process files');
  const captured=structuredClone(options),identity=JSON.stringify(captured);
  if(this.#legacyIdentity===undefined&&(this.#openingFiles||this.#openingImports))throw new Error('Legacy import must precede process filesystem capabilities');
  if(this.#legacyIdentity!==undefined&&this.#legacyIdentity!==identity)throw new Error('Legacy gcode source identity cannot change');
  this.#legacyIdentity=identity;
  return this.#legacyOpening??=prepareLegacyGcodes(captured,this.#files,AbortSignal.any([signal,this.#stopped.signal])).then(receipt=>{this.#legacyReady=true;return receipt;});
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
  if(this.#legacyIdentity!==undefined&&!this.#legacyReady)throw new Error('Legacy file publication has not completed');
  if(this.#lease)throw new Error('Previous native file generation has not retired');
  if(this.#retirementFailed||this.#offlineOperations)throw new Error('Native process files are not available for device attachment');
  const lease=Promise.withResolvers<void>();this.#lease=lease;
  return {files:this.#files,release:(confirmed=true)=>{if(this.#lease===lease){if(!confirmed)this.#retirementFailed=true;this.#lease=undefined;lease.resolve();}}};
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;this.#stopped.abort(new Error('Native process files closed'));
  this.#closing=(async()=>{await this.#lease?.promise;await this.#legacyOpening?.catch(()=>{});await this.#openingImports?.catch(()=>{});const results=await Promise.allSettled([this.#diskImports?.close()]);await this.#openingFiles?.catch(()=>{});try{await this.#processFiles?.drain();}catch(error){results.push({status:'rejected',reason:error});}try{await this.#files.close();}catch(error){results.push({status:'rejected',reason:error});}const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Native process files cleanup failed');})();return this.#closing;
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
 if('createProcess' in options){const dataPath=(options as NativeProductProcessOptions).dataPath;if(typeof dataPath!=='string'||!isAbsolute(dataPath)||!dataPath.isWellFormed()||/[\0\r\n]/u.test(dataPath)||Buffer.byteLength(dataPath)>4096)throw new TypeError('Native process requires an absolute data directory');}
 else if('dataPath' in options)throw new TypeError('Native process data directory requires process lifetime');
 if(options.configFiles&&!('createProcess' in options))throw new TypeError('Config files require process lifetime');
 if(options.diskImports&&!('createProcess' in options))throw new TypeError('Disk imports require process lifetime');
 storageRoots(options);
 if(options.diskImports){const root=options.diskImports.root;if(typeof root!=='string'||!isAbsolute(root)||/[\0\r\n]/u.test(root)||[options.filesRoot,options.metadataRoot].some(storage=>overlapping(resolve(root),resolve(storage))||overlapping(resolve(storage),resolve(root))))throw new TypeError('Disk inbox must be an absolute, separate storage root');}
 const legacyDatabase='createProcess' in options&&options.legacyDatabase?structuredClone(options.legacyDatabase):undefined;if(legacyDatabase)validateLegacyDatabasePreopen(legacyDatabase);
 const legacyPaths='createProcess' in options&&options.legacyPaths?structuredClone(options.legacyPaths):undefined;if(legacyPaths){validateLegacyProductPaths(legacyPaths);if(legacyPaths.dataPath!==('createProcess' in options?options.dataPath:undefined)||!legacyDatabase||dirname(legacyDatabase.databasePath)!==legacyPaths.directories.database||options.configFiles?.root!==legacyPaths.directories.config||overlapping(options.filesRoot,legacyPaths.directories.gcodes)||overlapping(legacyPaths.directories.gcodes,options.filesRoot))throw new TypeError('Legacy physical paths must match the actual process database/config and use separate published gcode backing');}
 const legacyGcodes='createProcess' in options&&options.legacyGcodes?structuredClone(options.legacyGcodes):undefined;
 const legacyConfiguration='createProcess' in options&&options.legacyConfiguration?structuredClone(options.legacyConfiguration):undefined;
 if(legacyConfiguration&&(!legacyPaths||!('createProcess' in options)||!options.installation||typeof legacyConfiguration.backupFile!=='string'||!isAbsolute(legacyConfiguration.backupFile)||resolve(legacyConfiguration.backupFile)!==legacyConfiguration.backupFile||/[\0\r\n]/u.test(legacyConfiguration.backupFile)))throw new TypeError('Backup configuration requires a trusted legacy installation profile');
 if(legacyGcodes&&(!legacyPaths||legacyGcodes.sourceQuiescent!==true||legacyGcodes.sourceRoot!==legacyPaths.directories.gcodes||!isAbsolute(legacyGcodes.recoveryRoot)||resolve(legacyGcodes.recoveryRoot)!==legacyGcodes.recoveryRoot||/[\0\r\n]/u.test(legacyGcodes.recoveryRoot)))throw new TypeError('Legacy gcode import must bind the approved physical source and private recovery directory');
 if('createProcess' in options&&options.installation?.options.legacy)throw new TypeError('Legacy installation proof is produced by the actual factory, not supplied as a profile assertion');
 if('createProcess' in options&&options.installation&&legacyPaths&&!legacyGcodes)throw new TypeError('Legacy installation requires actual retained-source gcode publication');
 const legacyDatabaseOwnerOptions='createProcess' in options&&options.legacyDatabaseOwnerOptions?Object.freeze(structuredClone(options.legacyDatabaseOwnerOptions)):undefined;
 if(legacyDatabaseOwnerOptions&&(!legacyDatabase||Object.keys(legacyDatabaseOwnerOptions).some(k=>!['backupDirectory','maxRecordBytes','maxDatabaseBytes','maxReplyBytes','maxPending','maxPendingBytes','maxReadCacheBytes'].includes(k))))throw new TypeError('Invalid trusted pre-open database owner options');
 const legacyOwner=legacyDatabase?resolveDatabaseStoreOptions({...legacyDatabaseOwnerOptions,path:legacyDatabase.databasePath,legacyAuthorization:legacyDatabase.authorization}):undefined;
 const snapshot={...options,machineProvider:'createProcess' in options&&options.machineProvider?structuredClone(options.machineProvider):undefined,diskImports:options.diskImports?structuredClone(options.diskImports):undefined,configFiles:options.configFiles?structuredClone(options.configFiles):undefined,files:{...options.files},uploads:{...options.uploads},standardPrint:options.standardPrint?{...options.standardPrint}:undefined},stopped=new AbortController();
 const processOptions='createProcess' in snapshot?snapshot:undefined;
 let processResources:NativeProductProcessResources|undefined,processOpening:Promise<void>|undefined,processJournal:PrintJournal|undefined,processIdentity:ProductMachineConfiguration|undefined;
 let machineProvider:MachineSystemProvider|undefined;
 let configFiles:NativeConfigFiles|undefined,preopenedDatabase:DatabaseStore|undefined,pathOwner:LegacyProductPathOwner|undefined;
 let projectedConfigFiles=snapshot.configFiles;
 let legacyGcodeReceipt:LegacyGcodeImportReceipt|undefined;
 let selectedBackupConfiguration=false,primaryConfiguration:string|undefined;
 let installationServer:ConfiguredMoonraker|undefined,installationControl:MachineControlPort|undefined;
 let logs:ProcessLogs|undefined,logging:ProcessLoggingOptions|undefined=processOptions?.logging;
 if(logging)validateProcessLogging(logging);
 let bootstrapping:ReturnType<NonNullable<ProductHostFactory['bootstrap']>>|undefined;
 let resources:NativeProductFileResources|undefined,pending:Promise<ProductHostProfile>|undefined,active=false,closing:Promise<void>|undefined;
 const ownBackend=(backend:SudoBackend):SudoBackend=>{let closed:Promise<void>|undefined;return {...backend.deployment?{deployment:(signal:AbortSignal)=>closed?Promise.reject(new ApiError(503,'Installation backend is closed')):backend.deployment!(signal)}:{},execute:(operation,password,signal)=>closed?Promise.reject(new ApiError(503,'Installation backend is closed')):backend.execute(operation,password,signal),close:()=>closed??=Promise.resolve().then(()=>backend.close())};};
 let installationBackend=processOptions?.installation?ownBackend(processOptions.installation.backend):undefined;
 let processCleanup:Promise<void>|undefined;
 const closeProcessResources=()=>processCleanup??=(async()=>{
  const failures:unknown[]=[];
  for(const close of [()=>resources?.close(),()=>processResources?.machineControl?.close(),()=>configFiles?.close(),()=>processJournal?.close(),()=>processResources?.release?.(),()=>preopenedDatabase?.close(),()=>installationBackend?.close(),()=>machineProvider?.close()])try{await close();}catch(error){failures.push(error);}
  logs?.lifecycle('shutdown_complete');for(const close of [()=>logs?.close(),()=>pathOwner?.close()])try{await close();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Native process cleanup failed');
 })();
 const ensureProcess=async(config:ProductMachineConfiguration,s:AbortSignal)=>{
  if(selectedBackupConfiguration&&config.moonrakerConfig===primaryConfiguration)config.moonrakerConfig=legacyConfiguration!.backupFile;
  if(legacyConfiguration&&!processIdentity&&!selectedBackupConfiguration){primaryConfiguration=config.moonrakerConfig;try{await loadConfiguration(config.moonrakerConfig);}catch(error){if(!(error instanceof ConfigurationError))throw error;await loadConfiguration(legacyConfiguration.backupFile);s.throwIfAborted();config.moonrakerConfig=legacyConfiguration.backupFile;selectedBackupConfiguration=true;}}
  if(processIdentity&&(['deviceId','journalPath','moonrakerConfig','printerConfig'] as const).some(key=>processIdentity![key]!==config[key]))throw new Error('Native process configuration identity cannot change');
  processIdentity??=structuredClone(config);
  processOpening??=(async()=>{
   if(processOptions?.installation){const o=processOptions.installation.options;if(o.dataPath!==processOptions.dataPath||o.configFile!==(selectedBackupConfiguration?primaryConfiguration:config.moonrakerConfig)||o.configRoot!==snapshot.configFiles?.root||o.gcodesRoot!==snapshot.filesRoot)throw new TypeError('Fixed installation must use the actual immutable process layout');}
   if(legacyPaths&&snapshot.diskImports){const source=await plannedPath(legacyPaths.directories.gcodes),inbox=await plannedPath(snapshot.diskImports.root);if(overlapping(source,inbox)||overlapping(inbox,source))throw new TypeError('Disk inbox must not overlap the retained legacy gcode source');}
   if(legacyGcodes){const roots=await Promise.all([legacyGcodes.sourceRoot,legacyGcodes.recoveryRoot,snapshot.filesRoot,snapshot.metadataRoot].map(plannedPath));for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(overlapping(roots[i],roots[j])||overlapping(roots[j],roots[i]))throw new TypeError('Legacy source, recovery and process publication roots must be separate');}
   if(legacyPaths){
    // Resolve every private overlap before alias/database publication. Public
    // paths never acquire this authority from an HTTP request.
    const startupReader=new ConfigurationReader(await loadConfiguration(config.moonrakerConfig)),tls=await selectTlsMaterialPaths(startupReader,legacyPaths.dataPath),secrets=await selectSecretsMaterialPath(startupReader,legacyPaths.dataPath);
    const root=await plannedPath(legacyPaths.directories.config),privatePaths=[legacyPaths.directories.database,legacyOwner?.backupDirectory,legacyGcodes?.recoveryRoot,snapshot.filesRoot,snapshot.metadataRoot,...Object.values(legacyPaths.files??{}),...(tls??[]),secrets.file].filter((p):p is string=>!!p),reserved=new Set(projectedConfigFiles?.reserved??[]);
    for(const input of privatePaths){const physical=await plannedPath(input);if(overlapping(physical,root))throw new TypeError('Public config root is contained by private process storage');if(overlapping(root,physical))reserved.add(relative(root,physical));}
    projectedConfigFiles=projectedConfigFiles?{...projectedConfigFiles,reserved:[...reserved]}:undefined;
    pathOwner=await LegacyProductPathOwner.open(legacyPaths,s);s.throwIfAborted();
   }
   if(legacyDatabase){if(processOptions?.installation&&processOptions.installation.options.databasePath!==legacyDatabase.databasePath)throw new TypeError('Legacy database must match installation identity');await prepareLegacyDatabase(legacyDatabase,s);s.throwIfAborted();preopenedDatabase=await DatabaseStore.open(legacyOwner!);s.throwIfAborted();}
   if(processOptions?.installation){const o=processOptions.installation.options;
   const database=await open(o.databasePath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const info=await database.stat(),header=Buffer.alloc(16),r=await database.read(header);if(!info.isFile()||r.bytesRead!==16||header.toString()!=='SQLite format 3\0')throw new TypeError('Fixed installation requires an existing selected SQLite database');}finally{await database.close();}}
   resources??=await NativeProductFileResources.open(snapshot);s.throwIfAborted();
   if(legacyGcodes){legacyGcodeReceipt=await resources.prepareLegacyGcodes(legacyGcodes,s);s.throwIfAborted();}
   processResources=await processOptions!.createProcess(structuredClone(config),s,preopenedDatabase?{database:preopenedDatabase,...pathOwner?{paths:pathOwner.mapping}:{} }:undefined);s.throwIfAborted();
   if(preopenedDatabase&&processResources.server.database!==preopenedDatabase)throw new TypeError('Legacy process must use the actual pre-opened identity database');
   if(!processResources||typeof processResources.release!=='function')throw new TypeError('Native process resources must own cleanup');
   if(processResources.server.templates!==undefined||processResources.server.authorization?.templateSecrets!==undefined)throw new TypeError('Native process owns template and secrets configuration');
   if('processLogs' in processResources.server)throw new TypeError('Native process owns logging');
   const providerReader=new ConfigurationReader(await loadConfiguration(config.moonrakerConfig));readMachineProvider(providerReader);
   if(processResources.server.systemServices?.source&&processOptions!.machineProvider)throw new TypeError('Explicit service source conflicts with machine provider capabilities');
   if(processResources.machineControl&&(processOptions!.machineProvider?.control||processOptions!.machineProvider?.supervisorControl||processOptions!.machineProvider?.nonePower))throw new TypeError('Explicit machine control conflicts with provider control descriptor');
   if(!processResources.server.systemServices?.source){let guardReleased=false;const guard=processResources.machineDeviceGuard,guardOwner=processResources;if(guard!==undefined&&(!guard||typeof guard.assertDeviceAvailable!=='function'))throw new TypeError('Invalid borrowed machine device guard');if(guard){const release=guardOwner.release;processResources.release=async()=>{guardReleased=true;await release.call(guardOwner);};}const deviceGuard=guard?{async assertDeviceAvailable(signal:AbortSignal){if(guardReleased)throw new ApiError(503,'Borrowed device guard is released');await guard.assertDeviceAvailable(signal);signal.throwIfAborted();if(guardReleased)throw new ApiError(503,'Borrowed device guard retired during proof');}}:undefined;machineProvider=new MachineSystemProvider(providerReader,processOptions!.machineProvider,true,{deviceGuard});processResources.server={...processResources.server,systemServices:machineProvider.services};if(machineProvider.control)processResources.machineControl=machineProvider.control;}
   if(processResources.server.systemPackages?.bus&&machineProvider?.bus&&processResources.server.systemPackages.bus!==machineProvider.bus)throw new TypeError('PackageKit must borrow the process machine bus');
   const systemPackages={bus:machineProvider?.bus,apt:{commands:{apt:'/usr/bin/apt',aptGet:'/usr/bin/apt-get',aptCache:'/usr/bin/apt-cache'},privilege:{command:'/usr/bin/sudo',args:['-n','--'],envCommand:'/usr/bin/env'}},...processResources.server.systemPackages};
   processResources.server={...processResources.server,systemPackages};
   await machineProvider?.prepare(s);s.throwIfAborted();
   processResources.server={...processResources.server,...machineProvider?.warnings.length?{information:{...processResources.server.information,warnings:[...processResources.server.information.warnings,...machineProvider.warnings]}}:{},templates:{dataPath:processOptions!.dataPath}};
   if(snapshot.diskImports&&typeof processResources.diskImportContext!=='function')throw new TypeError('Disk imports require the current process filesystem policy');
   if(processResources.machineControl&&(['retirement','execute','assertDeviceAvailable','close'] as const).some(key=>typeof processResources!.machineControl![key]!=='function'))throw new TypeError('Invalid native machine control capability');
   assertProductAuthorization(processResources.server,true);new ServerInformation(processResources.server.information);
   await loadWelcomeSource();s.throwIfAborted();
   await readTlsConfiguration(new ConfigurationReader(await loadConfiguration(config.moonrakerConfig)),processResources.server.templates?.dataPath??processResources.server.authorization?.templateSecrets?.dataPath);s.throwIfAborted();
   if(['installation','nativeDetached','productPrint','nativeHost','nativeObjects','maintenanceGate','nativeUploads','productPrintCompatibility','nativeProcessFiles','nativeProcessHistory','configFiles'].some(key=>key in processResources!.server))throw new TypeError('Native process resources cannot override native resource owners');
   if(logging?.applicationFile&&processResources.server.applicationLogFile||logging?.printerFile&&processResources.server.printerLogFile)throw new TypeError('Writable and borrowed log ownership conflict');
   const productionLogRoot=resolve(processOptions!.dataPath,legacyPaths?'node-private-logs':'logs');
   const paths={moonraker:logging?.disableFile?undefined:logging?.applicationFile??(processResources.server.applicationLogFile?undefined:resolve(productionLogRoot,'moonraker.log')),klipper:logging?.printerFile??(processResources.server.printerLogFile?undefined:resolve(productionLogRoot,'klippy.log'))};
   const logReader=new ConfigurationReader(await loadConfiguration(config.moonrakerConfig)),legacySecrets=logReader.section('secrets').get('secrets_path',{defaultValue:null}),tlsPaths=['ssl_certificate_path','ssl_key_path'].map(key=>logReader.section('server').get(key,{defaultValue:null}));
   const blocked=[...logReader.snapshot().files.map(file=>file.filename),processResources.server.database?.storagePaths.path,processResources.server.database?.storagePaths.backupDirectory,resolve(processOptions!.dataPath,'certs'),...tlsPaths.filter((p):p is string=>!!p).map(resolveConfigurationPath),snapshot.filesRoot,snapshot.metadataRoot,snapshot.configFiles?.root,snapshot.diskImports?.root,config.printerConfig,config.moonrakerConfig,config.journalPath,config.journalPath+'.host-recovery.sqlite',resolve(processOptions!.dataPath,'moonraker.secrets'),legacySecrets?resolve(expandConfigurationUserPath(legacySecrets)):undefined].filter((p):p is string=>!!p);
   const physicalBlocked=await Promise.all(blocked.map(plannedPath)),selected=await Promise.all(Object.values(paths).filter((p):p is string=>!!p).map(plannedPath));
   for(const file of selected){const directory=dirname(file);if(physicalBlocked.some(p=>overlapping(p,directory)||overlapping(directory,p)))throw new TypeError('Log directory overlaps writable or private process storage');}
   if(selected.length===2&&selected[0]===selected[1])throw new TypeError('Application and printer logs require separate files');
   for(const file of Object.values(paths))if(file&&dirname(file)===productionLogRoot)await mkdir(dirname(file),{recursive:true,mode:0o700});
   logs=await ProcessLogs.open(paths,logging??{},processResources.server.information.version);s.throwIfAborted();logs.lifecycle('bootstrap');
   processResources.server={...processResources.server,processLogs:logs};
   if(projectedConfigFiles){configFiles=await NativeConfigFiles.open(projectedConfigFiles);if(!configFiles.contains(config.printerConfig))throw new TypeError('Printer config must be inside the explicit config root');s.throwIfAborted();}
   await resources!.processFiles(snapshot.uploads);s.throwIfAborted();
   processJournal=await PrintJournal.open({path:config.journalPath,deviceId:config.deviceId});s.throwIfAborted();
  })();await processOpening;s.throwIfAborted();await pathOwner?.verify(s);
 };
 const factory:ProductHostFactory=(incoming,reload)=>{
  if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);
  if(active)return Promise.reject(new Error('Previous native profile has not retired'));
  if(legacyPaths){if(!installationServer)return Promise.reject(new ApiError(503,'Legacy migration requires the actual installation consumer before device acquisition'));try{installationServer.assertInstallationReady();}catch(error){return Promise.reject(error);}}
  incoming.throwIfAborted();active=true;const signal=AbortSignal.any([incoming,stopped.signal]);
  const task=loadProductMachineProfile(path,async(config,s,gate)=>{
   let createAdapter:NativeProductMachineOptions['createAdapter'];
   if(processOptions){
    await ensureProcess(config,s);
    installationServer?.assertInstallationReady();
    createAdapter=async(c,signal,g)=>{
     await installationServer?.assertInstallationReadyFresh(signal);signal.throwIfAborted();
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
  closing=(async()=>{await pending?.catch(()=>{});await bootstrapping?.catch(()=>{});await Promise.allSettled([processOpening]);await closeProcessResources();})();return closing;
 };
 if(processOptions){
  factory.configureLogging=value=>{if(processOpening||bootstrapping||active||closing)throw new TypeError('Log configuration requires unstarted process');validateProcessLogging(value);if(logging)throw new TypeError('CLI and profile logging owners conflict');logging={...value};};
  factory.logLifecycle=(event,reason)=>logs?.lifecycle(event,reason);
  Object.defineProperty(factory,'serverLifetime',{value:'process',enumerable:true});
  Object.defineProperty(factory,'diskImportStatus',{get:()=>resources?.status.diskImports,enumerable:true});
  Object.defineProperty(factory,'machineControl',{get:()=>installationControl??processResources?.machineControl,enumerable:true});
  factory.resetFirmware=(profile,signal)=>resetConfiguredFirmware(profile.reader,profile.policies,signal);
  factory.bootstrap=(incoming,control)=>{
   if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);incoming.throwIfAborted();
   if(active)return Promise.reject(new Error('Native process bootstrap must precede device acquisition'));
   return bootstrapping??=(async()=>{
    const signal=AbortSignal.any([incoming,stopped.signal]),config=await readProductMachine(path,signal);
    const attempt=async()=>{await ensureProcess(config,signal);
    const process=processResources!.server,files=await resources!.processFiles(snapshot.uploads),serviceProvider=machineProvider;
    const installation=processOptions.installation?{...processOptions.installation,backend:installationBackend!,options:{...processOptions.installation.options,configFile:config.moonrakerConfig,...serviceProvider&&!processOptions.installation.options.serviceIdentity&&!processOptions.installation.options.serviceInfo?{serviceInfo:serviceProvider.serviceInfo}:{},...legacyPaths?{legacy:{bindings:pathOwner!.mapping,gcodeImport:legacyGcodeReceipt!,backupConfiguration:selectedBackupConfiguration,...processOptions.installation.externalService?{externalService:processOptions.installation.externalService}:{}}}:{}}}:undefined;
    const systemPackages=process.systemPackages;
    const serverOptions={nativeDetached:true as const,configFiles,nativeProcessFiles:files,nativeProcessHistory:processJournal!,productHostControl:control,systemPackages,...installation?{installation}:{},
     nativePrinterIdentity:{configFile:config.printerConfig,softwareVersion:process.information.version},systemInformation:process.systemInformation??{},systemServices:process.systemServices??{},procStats:process.procStats??{},gcodeStore:process.gcodeStore??{},temperatureStore:{...process.temperatureStore,previous:undefined}};
    const server=process.authorization?await ConfiguredMoonraker.loadAuthorized(config.moonrakerConfig,{...process,...serverOptions}):await ConfiguredMoonraker.load(config.moonrakerConfig,{...process,...serverOptions});
    componentsLoaded=true;
    if(installation)processResources!.server={...processResources!.server,installation};
    if(processOptions.installation){installationServer=server;const original=processResources!.machineControl,readonlyControl=original??(machineProvider?.bus?new SystemdBusControl(machineProvider.bus,{ownUnit:processOptions.installation.options.unit},machineProvider.configuration.shutdown):new LinuxMachineControl({ownUnit:processOptions.installation.options.unit}));processResources!.machineControl=readonlyControl;
     installationControl={retirement(action){if(server.installationStatus?.ready&&original)return original.retirement(action);if(action.kind!=='server_restart')throw new ApiError(403,'Pending installation supports only own-unit process restart');return 'process';},execute(action,signal){if(server.installationStatus?.ready&&original)return original.execute(action,signal);if(action.kind!=='server_restart')return Promise.reject(new ApiError(403,'Unsupported installation action'));return server.executeInstallationRestart(signal);},assertDeviceAvailable:signal=>readonlyControl.assertDeviceAvailable(signal),close:()=>readonlyControl.close()};}
    if(snapshot.diskImports)try{await resources!.startDiskImports({...snapshot.diskImports,context:signal=>processResources!.diskImportContext!(AbortSignal.any([signal,stopped.signal]))});}catch(error){await server.close();throw error;}
    return {server,recoveryJournal:{path:config.journalPath+'.host-recovery.sqlite',deviceId:config.deviceId}};};
    let componentsLoaded=false;
    try{return await attempt();}catch(error){
     if(componentsLoaded||!(error instanceof ConfigurationError)||!legacyConfiguration||selectedBackupConfiguration||signal.aborted)throw error;
     // Never reopen over a live or uncertain first generation. Completed
     // aliases, SQLite migration and gcode journal stay durable; active owners
     // are all closed and the backup reopens those journals without replay.
     try{await closeProcessResources();}catch(cleanup){throw new AggregateError([error,cleanup],'Primary configuration and process cleanup failed');}
     if(!processOptions.installation?.reopenBackend)throw new AggregateError([error,new Error('Backup requires a fresh installation backend')],'Backup process capability unavailable');
     const next=processOptions.installation.reopenBackend();if(next===processOptions.installation.backend)throw new TypeError('Backup installation backend must be a new owner');
     installationBackend=ownBackend(next);processCleanup=undefined;processResources=undefined;processOpening=undefined;processIdentity=undefined;processJournal=undefined;configFiles=undefined;preopenedDatabase=undefined;pathOwner=undefined;resources=undefined;logs=undefined;machineProvider=undefined;legacyGcodeReceipt=undefined;installationServer=undefined;installationControl=undefined;
     // Preserve every private source seen in this process while the next
     // configuration adds its newly selected physical material paths.
     projectedConfigFiles=projectedConfigFiles?{...snapshot.configFiles!,reserved:[...(projectedConfigFiles.reserved??[])]}:undefined;
     selectedBackupConfiguration=true;config.moonrakerConfig=legacyConfiguration.backupFile;signal.throwIfAborted();return await attempt();
    }
   })();
  };
 }

 return factory;
}
