import {isAbsolute,relative,resolve,sep} from 'node:path';
import {PublishedPrintFiles} from '../storage/published-files.ts';
import {NativePrintUploads,type NativeUploadOptions} from '../moonraker/native-print-uploads.ts';
import {ServerInformation} from '../moonraker/metadata.ts';
import {ApiError} from '../moonraker/rpc.ts';
import type {ProductMachineConfiguration} from '../config/product-machine.ts';
import {MaintenanceGate} from '../operations/maintenance-gate.ts';
import {loadProductMachineProfile,type ProductMachineBindings} from './product-machine-profile.ts';

export interface NativeMachineAdapter {
 stops:ProductMachineBindings['stops'];
 lifecycle:ProductMachineBindings['print']['lifecycle'];
 output:ProductMachineBindings['print']['output'];
 /** Source admission policy in addition to RPC authorization. Must not move or heat. */
 authorizePrintFile(fileId:string,signal:AbortSignal):Promise<void>;
 server:Omit<ProductMachineBindings['server'],'nativeUploads'|'productPrintCompatibility'>;
 /** Adapter owns its own partial failure; a successful factory return transfers ownership. */
 release():Promise<void>;
}
export interface NativeProductMachineOptions {
 filesRoot:string;metadataRoot:string;
 files?:Parameters<typeof PublishedPrintFiles.open>[1];
 uploads?:NativeUploadOptions;
 /** Explicit preparation temperatures for filename-only client requests. No file macro inference. */
 standardPrint?:{nozzle:number;bed:number};
 createAdapter(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate):Promise<NativeMachineAdapter>;
}
function overlapping(a:string,b:string):boolean {const rel=relative(a,b);return rel===''||!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+sep);}
/** Assemble native file/metadata ownership once for real machine profiles and
 * compiled acceptance. Caller retires all printer/server owners before release. */
export async function createNativeProductBindings(configuration:ProductMachineConfiguration,signal:AbortSignal,gate:MaintenanceGate,options:NativeProductMachineOptions):Promise<ProductMachineBindings>{
 signal.throwIfAborted();
 if(!(gate instanceof MaintenanceGate)||gate.status.closed||typeof options.createAdapter!=='function')throw new TypeError('Open gate and native machine adapter factory are required');
 for(const path of [options.filesRoot,options.metadataRoot])if(typeof path!=='string'||!isAbsolute(path)||/[\0\r\n]/u.test(path))throw new TypeError('Native product storage requires absolute paths');
 const filesRoot=resolve(options.filesRoot),metadataRoot=resolve(options.metadataRoot);
 if(overlapping(filesRoot,metadataRoot)||overlapping(metadataRoot,filesRoot))throw new TypeError('Native file and metadata roots must be separate');
 const config=structuredClone(configuration),ids=Object.keys(config.mcus),filesOptions={...options.files},uploadOptions={...options.uploads},standard=options.standardPrint?{nozzle:options.standardPrint.nozzle,bed:options.standardPrint.bed}:undefined,createAdapter=options.createAdapter;
 if(standard&&(!Number.isFinite(standard.nozzle)||standard.nozzle<0||standard.nozzle>config.limits.maxNozzle||!Number.isFinite(standard.bed)||standard.bed<0||standard.bed>config.limits.maxBed))throw new TypeError('Standard print temperatures exceed machine limits');
 let adapter:NativeMachineAdapter|undefined,files:PublishedPrintFiles|undefined,uploads:NativePrintUploads|undefined,closing:Promise<void>|undefined;
 const stopped=new AbortController(),pending=new Set<Promise<unknown>>();
 const track=<T>(work:()=>Promise<T>):Promise<T>=>{if(stopped.signal.aborted)return Promise.reject(stopped.signal.reason);if(pending.size>=8)return Promise.reject(new ApiError(429,'Native file admission capacity exceeded'));const task=Promise.resolve().then(work);pending.add(task);void task.then(()=>pending.delete(task),()=>pending.delete(task));return task;};
 const release=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;stopped.abort(new Error('Native machine bindings closed'));
  void (async()=>{await Promise.allSettled([...pending]);const errors:unknown[]=[];for(const close of [()=>uploads?.close(),()=>files?.close(),()=>adapter?.release()])try{await close();}catch(error){errors.push(error);}if(errors.length)throw new AggregateError(errors,'Native machine bindings cleanup failed');})().then(done.resolve,done.reject);return closing;
 };
 try{
  adapter=await createAdapter(structuredClone(config),signal,gate);signal.throwIfAborted();
  if(!adapter||typeof adapter.release!=='function'||typeof adapter.output!=='function'||typeof adapter.authorizePrintFile!=='function'||typeof adapter.server?.authorize!=='function'||typeof adapter.server?.authorizeNotification!=='function'||!adapter.stops||adapter.stops.size!==ids.length||ids.some(id=>typeof adapter!.stops.get(id)!=='function'))throw new TypeError('Incomplete native machine adapter');
  for(const key of ['prepare','start','finishOutputs','stopOutputs'] as const)if(typeof adapter.lifecycle?.[key]!=='function')throw new TypeError('Incomplete native machine output lifecycle');
  if('nativeUploads' in adapter.server||'productPrintCompatibility' in adapter.server)throw new TypeError('Native product owns file and standard print bindings');
  new ServerInformation(adapter.server.information);
  const authorize=adapter.authorizePrintFile.bind(adapter),output=adapter.output.bind(adapter),lifecycle={...adapter.lifecycle},stops=new Map(adapter.stops),server={...adapter.server,information:structuredClone(adapter.server.information)};
  files=await PublishedPrintFiles.open(filesRoot,filesOptions);signal.throwIfAborted();
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
