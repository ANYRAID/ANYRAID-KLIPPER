import type {TemperatureStore} from '../moonraker/temperature-store.ts';
import {ProductHostControl,type HostReloadKind} from './product-host-control.ts';
import {startConfiguredMachineService,type ConfiguredProductServiceOptions} from './product-service.ts';
import type {ProductPrinterOptions} from './product-printer.ts';
import type {MCUMachinePolicy} from './configured-mcu-connections.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {AddressInfo} from 'node:net';
import type {ConfiguredMoonraker} from '../moonraker/configured-server.ts';
import {MCUConfigurationFault} from '../protocol/mcu-config.ts';
import {FirmwareFault} from '../protocol/firmware-fault.ts';
/** Inspect bounded trusted causes, never classify by arbitrary message text. */
function firmwareRecoveryFailure(error:unknown):'mcu_shutdown'|'mcu_configuration_mismatch'|undefined{
 const pending:unknown[]=[error],seen=new Set<Error>();
 while(pending.length&&seen.size<32){
  const item=pending.pop();if(!(item instanceof Error)||seen.has(item))continue;seen.add(item);
  if(item instanceof MCUConfigurationFault)return item.code==='shutdown'?'mcu_shutdown':'mcu_configuration_mismatch';
  if(item instanceof FirmwareFault&&item.details.event!=='starting')return 'mcu_shutdown';
  if(item instanceof AggregateError)pending.push(...item.errors.slice(0,32).toReversed());
  if(item.cause instanceof Error)pending.push(item.cause);
 }
}
/** Trusted machine integration, never supplied by an uploaded print file.
 * The factory cleans up its own partial failure. On success, resource lifetime
 * transfers to the host; release runs after all service owners have retired. */
export interface ProductHostProfile {
 recoveryJournal?:{path:string;deviceId:string};
 reader:ConfigurationReader;
 policies:ReadonlyMap<string,MCUMachinePolicy>;
 product:ProductPrinterOptions;
 options:ConfiguredProductServiceOptions;
 release():Promise<void>;
}
export interface HostReloadContext {readonly reason:'initial'|HostReloadKind;}
export interface ProductHostFactory {
 (signal:AbortSignal,context?:HostReloadContext):Promise<ProductHostProfile>;
 /** Explicit process dependency ownership. Must also provide final cleanup. */
 readonly serverLifetime?:'process';
 /** Process resources outlive profiles. The host invokes this only after the
  * final generation retires, including startup and retirement failures. */
 close?():Promise<void>;
 /** Validated process resources independent of printer configuration/hardware. */
 bootstrap?(signal:AbortSignal,control:ProductHostControl):Promise<{server:ConfiguredMoonraker;recoveryJournal:{path:string;deviceId:string}}>;
}
/** One process lifetime: load -> connect -> listen -> stop -> release dependencies.
 * Hardware stop does not close the API: keep durable outcomes and unavailable
 * hardware status observable until explicit process shutdown. No automatic reconnect or replay. */
export async function runProductHost(factory:ProductHostFactory,signal:AbortSignal,ready:(address:AddressInfo)=>void,control?:ProductHostControl,listening?:(address:AddressInfo)=>void):Promise<void>{
 control??=new ProductHostControl();
 signal.throwIfAborted();if(typeof factory!=='function'||typeof ready!=='function'||factory.close!==undefined&&typeof factory.close!=='function'||factory.serverLifetime!==undefined&&factory.serverLifetime!=='process'||factory.serverLifetime==='process'&&!factory.close)throw new TypeError('Invalid product host callbacks');
 if(factory.bootstrap!==undefined&&(typeof factory.bootstrap!=='function'||factory.serverLifetime!=='process')||listening!==undefined&&typeof listening!=='function')throw new TypeError('Invalid product process bootstrap');
 const processLifetime=factory.serverLifetime==='process';let processServer:ConfiguredMoonraker|undefined;
 const stopped=Promise.withResolvers<void>(),abort=()=>stopped.resolve(),errors:unknown[]=[];
 let temperatureHistory:TemperatureStore|undefined;
 let profile:ProductHostProfile|undefined,service:Awaited<ReturnType<typeof startConfiguredMachineService>>|undefined,detach=()=>{},completion:ReturnType<typeof Promise.withResolvers<void>>|undefined,activeRequest:ReturnType<typeof Promise.withResolvers<void>>|undefined;
 const closeGeneration=async()=>{
  detach();detach=()=>{};const oldService=service,oldProfile=profile;service=undefined;profile=undefined;
  const failures:unknown[]=[];
  if(oldService)try{await oldService.close();if(!processLifetime)temperatureHistory=oldService.server.retiredTemperatureHistory();}catch(error){failures.push(error);}
  if(oldProfile)try{await oldProfile.release();}catch(error){failures.push(error);}
  if(failures.length)throw new AggregateError(failures,'Product generation cleanup failed');
 };
 signal.addEventListener('abort',abort,{once:true});
 try{
  if(factory.bootstrap){const process=await factory.bootstrap(signal,control);processServer=process.server;await control.configure(process.recoveryJournal);signal.throwIfAborted();const address=await processServer.start();signal.throwIfAborted();listening?.({...address});}
  const reload:{reason:HostReloadContext['reason']}={reason:'initial'};
  while(!signal.aborted){
   try{
   profile=await factory(signal,{reason:reload.reason});
   if(!profile||typeof profile.release!=='function')throw new TypeError('Machine profile must own dependency cleanup');
   // A host reload must not enter the UART bootloader/reset startup path.
   const policies=reload.reason==='restart'?new Map([...profile.policies].map(([id,p])=>[id,p.transport==='uart'?{...p,leaveBootloader:false}:p])):profile.policies;
   await control.configure(profile.recoveryJournal);signal.throwIfAborted();service=await startConfiguredMachineService(profile.reader,policies,profile.product,{...profile.options,serverLifetime:processLifetime?'process':'generation',existingServer:processServer,server:{...profile.options.server,temperatureStore:{...profile.options.server.temperatureStore,previous:temperatureHistory},productHostControl:control}},signal);
   if(processLifetime)processServer??=service.server;
   temperatureHistory=undefined;
   service.printer.group.assertActive();signal.throwIfAborted();
   const generation=service,change=Promise.withResolvers<void>();let requested:ReturnType<typeof Promise.withResolvers<void>>|undefined;
   const validate=(kind:HostReloadKind)=>{
    signal.throwIfAborted();const printer=generation.printer,state=printer.controller.state,gate=printer.maintenanceGate.status;
    if(kind==='restart'){if(!processLifetime||gate.maintenance)throw new Error('Restart requires process ownership and no active maintenance');return;}
    if(!['idle','completed','cancelled','failed'].includes(state)||printer.controller.pendingDeviceActions||printer.controller.safeStopPending||gate.activities||gate.maintenance||printer.group.status.state==='failed')throw new Error('Reinitialization requires a quiescent printer and confirmed physical stop');
   };
   detach=control.attach(kind=>{validate(kind);const printer=generation.printer;
    // Fence producers synchronously before yielding to any HTTP request.
    printer.maintenanceGate.invalidate();reload.reason=kind;requested=Promise.withResolvers<void>();activeRequest=requested;change.resolve();return requested.promise;
   },validate,{kinds:processLifetime?['reinitialize','restart']:['reinitialize'],generationSignal:service.server.nativeGenerationSignal});
   ready({...service.address});errors.length=0;completion?.resolve();completion=undefined;
   await Promise.race([stopped.promise,change.promise]);
   completion=requested;activeRequest=undefined;await closeGeneration();
   if(!requested)break;
   }catch(error){
    // Startup owners aggregate their primary error with failed stop/cleanup.
    // That failure can precede transfer into `service`/`profile`; do not infer
    // safe retirement merely from the previous server's stopped snapshot.
    let cleanupFailed=error instanceof AggregateError;
    if(!signal.aborted||error!==signal.reason){if(error instanceof AggregateError&&error.message==='Product generation cleanup failed')errors.push(...error.errors);else errors.push(error);}
    try{await closeGeneration();}catch(cleanup){cleanupFailed=true;if(cleanup instanceof AggregateError)errors.push(...cleanup.errors);else errors.push(cleanup);}
    completion??=activeRequest;
    completion?.reject(new AggregateError(errors,'Product reinitialization failed'));completion=activeRequest=undefined;
    if(!processServer||signal.aborted)break;
    if(processServer.nativeGenerationStatus?.drained)processServer.recordNativeStartupFailure(cleanupFailed,firmwareRecoveryFailure(error));
    // Only an explicitly requested retry may create a replacement. A failed
    // physical/dependency retirement cannot be made safe by a host reload.
    if(cleanupFailed||processServer.nativeGenerationStatus?.state!=='stopped'){await stopped.promise;break;}
    const change=Promise.withResolvers<void>();let requested:ReturnType<typeof Promise.withResolvers<void>>|undefined;
    detach=control.attach(kind=>{signal.throwIfAborted();if(kind!=='restart')throw new Error('Only explicit RESTART can retry a failed replacement');reload.reason=kind;requested=Promise.withResolvers<void>();activeRequest=requested;change.resolve();return requested.promise;},()=>signal.throwIfAborted(),{kinds:['restart'],generationSignal:processServer.nativeGenerationSignal});
    await Promise.race([stopped.promise,change.promise]);detach();detach=()=>{};completion=requested;activeRequest=undefined;
    if(!requested)break;
   }
  }
 }catch(error){
  if(!signal.aborted||error!==signal.reason){if(error instanceof AggregateError&&error.message==='Product generation cleanup failed')errors.push(...error.errors);else errors.push(error);}
  try{await closeGeneration();}catch(cleanup){if(cleanup instanceof AggregateError)errors.push(...cleanup.errors);else errors.push(cleanup);}
  completion??=activeRequest;
  if(completion){completion.reject(new AggregateError(errors,'Product reinitialization failed'));completion=activeRequest=undefined;}
  // A failed replacement must stay observable. Only explicit process shutdown
  // closes the retained listener; there is no automatic device retry or replay.
  if(processServer?.status.phase==='listening'&&!signal.aborted)await stopped.promise;
 }
 finally{
  signal.removeEventListener('abort',abort);
  try{await closeGeneration();}catch(error){if(error instanceof AggregateError)errors.push(...error.errors);else errors.push(error);}
  completion??=activeRequest;
  if(completion)completion.reject(errors.length?new AggregateError(errors,'Product reinitialization failed'):signal.reason??new Error('Product host stopped before reinitialization'));
 }
 try{await processServer?.close();}catch(error){errors.push(error);}
 try{await factory.close?.();}catch(error){errors.push(error);}
 try{await control.close();}catch(error){errors.push(error);}
 if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Product host and resource cleanup failed');
}
