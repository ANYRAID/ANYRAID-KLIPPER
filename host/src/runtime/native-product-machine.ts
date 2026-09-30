import {isAbsolute,relative,resolve,sep} from 'node:path';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {NativePrintUploads,type NativeUploadOptions} from '../moonraker/native-print-uploads.ts';
import {ServerInformation} from '../moonraker/metadata.ts';
import {assertProductAuthorization} from './product-authorization.ts';
import {ApiError} from '../moonraker/rpc.ts';
import type {ProductMachineConfiguration} from '../config/product-machine.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {loadProductMachineProfile,type ProductMachineBindings} from './product-machine-profile.ts';
import type {ProductHostFactory,ProductHostProfile} from './product-host.ts';

type NativeAdapterServer<T>=T extends unknown?Omit<T,'nativeUploads'|'productPrintCompatibility'>:never;
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
 /** Borrowed process storage. A profile closes its admission/metadata layer,
  * releases its lease and adapter, but cannot close the file store. */
 fileResources?:NativeProductFileResources;
 /** Explicit preparation temperatures for filename-only client requests. No file macro inference. */
 standardPrint?:{nozzle:number;bed:number};
 createAdapter(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate):Promise<NativeMachineAdapter>;
}
function overlapping(a:string,b:string):boolean {const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
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
 private constructor(files:PublishedPrintFiles,filesRoot:string,metadataRoot:string){this.#files=files;this.#filesRoot=filesRoot;this.#metadataRoot=metadataRoot;}
 static async open(options:Pick<NativeProductMachineOptions,'filesRoot'|'metadataRoot'|'files'>):Promise<NativeProductFileResources>{
  const {filesRoot,metadataRoot}=storageRoots(options),files=await PublishedPrintFiles.open(filesRoot,{...options.files});
  return new NativeProductFileResources(files,filesRoot,metadataRoot);
 }
 get status(){return {closing:this.#closed,leased:!!this.#lease,files:this.#files.status};}
 acquire(options:Pick<NativeProductMachineOptions,'filesRoot'|'metadataRoot'>):{files:PublishedPrintFiles;release:()=>void}{
  const roots=storageRoots(options);
  if(roots.filesRoot!==this.#filesRoot||roots.metadataRoot!==this.#metadataRoot)throw new Error('Native process storage identity cannot change');
  if(this.#closed||this.#files.status.closed)throw new Error('Native process files closed');
  if(this.#lease)throw new Error('Previous native file generation has not retired');
  const lease=Promise.withResolvers<void>();this.#lease=lease;
  return {files:this.#files,release:()=>{if(this.#lease===lease){this.#lease=undefined;lease.resolve();}}};
 }
 close():Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;
  this.#closing=(async()=>{await this.#lease?.promise;await this.#files.close();})();return this.#closing;
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
 let adapter:NativeMachineAdapter|undefined,files:PublishedPrintFiles|undefined,uploads:NativePrintUploads|undefined,closing:Promise<void>|undefined,fileLease:{files:PublishedPrintFiles;release:()=>void}|undefined;
 const stopped=new AbortController(),pending=new Set<Promise<unknown>>();
 const track=<T>(work:()=>Promise<T>):Promise<T>=>{if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);if(pending.size>=8)return Promise.reject(new ApiError(429,'Native file admission capacity exceeded'));const task=Promise.resolve().then(work);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;};
 const release=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;stopped.abort(new Error('Native machine bindings closed'));
  void (async()=>{await Promise.allSettled([...pending]);const errors:unknown[]=[];for(const close of [()=>uploads?.drain(),()=>resources?undefined:files?.close(),()=>adapter?.release()])try{await close();}catch(error){errors.push(error);}fileLease?.release();if(errors.length)throw new AggregateError(errors,'Native machine bindings cleanup failed');})().then(done.resolve,done.reject);return closing;
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
  uploads=await NativePrintUploads.open(files,gate,{...uploadOptions,metadataRoot});signal.throwIfAborted();
  const ownedFiles=files,ownedUploads=uploads;
  const active=(incoming:AbortSignal)=>{const combined=AbortSignal.any([incoming,stopped.signal]);combined.throwIfAborted();if(gate.status.closed)throw new ApiError(503,'Machine admission closed');return combined;};
  const resolveFile=async(id:string,incoming:AbortSignal)=>{const s=active(incoming);if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw new ApiError(400,'Invalid native file ID');await authorize(id,s);s.throwIfAborted();if(gate.status.closed)throw new ApiError(503,'Machine admission closed');return s;};
  return {stops,print:{lifecycle,output,open(id,incoming){return track(async()=>ownedFiles.acquire(id,await resolveFile(id,incoming)));}},server:{...server,nativeUploads:ownedUploads,...standard?{productPrintCompatibility:{start(filename,incoming){return track(async()=>{if(!/^[A-Za-z0-9_-]{1,128}[.]gcode$/.test(filename))throw new ApiError(400,'Invalid native filename');const fileId=filename.slice(0,-6),s=await resolveFile(fileId,incoming);try{await ownedFiles.describe(fileId,s);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')throw new ApiError(404,'Published file not found');throw error;}s.throwIfAborted();return {fileId,...standard};});}}}:{}},release};
 }catch(error){try{await release();}catch(cleanup){throw new AggregateError([error,cleanup],'Native machine assembly and cleanup failed',{cause:error});}throw error;}
}
export function loadNativeProductMachineProfile(path:string,options:NativeProductMachineOptions,signal:AbortSignal){
 return loadProductMachineProfile(path,(config,s,gate)=>createNativeProductBindings(config,s,gate,options),signal);
}
/** Product entry factory: process files survive profile release/reinitialization.
 * The existing server and adapter still belong to each generation; retaining
 * them across native restart requires the separate server rebinding boundary. */
export function createNativeProductHostFactory(path:string,options:Omit<NativeProductMachineOptions,'fileResources'>):ProductHostFactory{
 if(typeof options.createAdapter!=='function')throw new TypeError('Native machine adapter factory is required');
 storageRoots(options);
 const snapshot={...options,files:{...options.files},uploads:{...options.uploads},standardPrint:options.standardPrint?{...options.standardPrint}:undefined},stopped=new AbortController();
 let resources:NativeProductFileResources|undefined,pending:Promise<ProductHostProfile>|undefined,active=false,closing:Promise<void>|undefined;
 const factory:ProductHostFactory=(incoming)=>{
  if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);
  if(active)return Promise.reject(new Error('Previous native profile has not retired'));
  incoming.throwIfAborted();active=true;const signal=AbortSignal.any([incoming,stopped.signal]);
  const task=loadProductMachineProfile(path,async(config,s,gate)=>{
   resources??=await NativeProductFileResources.open(snapshot);s.throwIfAborted();
   return createNativeProductBindings(config,s,gate,{...snapshot,files:undefined,fileResources:resources});
  },signal).then(profile=>{
   const release=profile.release;let retiring:Promise<void>|undefined;
   profile.release=()=>retiring??=(async()=>{try{await release();}finally{active=false;}})();return profile;
  },error=>{active=false;throw error;});
  pending=task;void task.then(()=>{if(pending===task)pending=undefined;},()=>{if(pending===task)pending=undefined;});return task;
 };
 factory.close=()=>{
  if(closing)return closing;stopped.abort(new Error('Native product factory closed'));
  closing=(async()=>{await pending?.catch(()=>{});await resources?.close();})();return closing;
 };
 return factory;
}
