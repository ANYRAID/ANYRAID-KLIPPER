import type {TemperatureStore} from '../moonraker/temperature-store.ts';
import {ProductHostControl} from './product-host-control.ts';
import {startConfiguredMachineService,type ConfiguredProductServiceOptions} from './product-service.ts';
import type {ProductPrinterOptions} from './product-printer.ts';
import type {MCUMachinePolicy} from './configured-mcu-connections.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {AddressInfo} from 'node:net';
import type {ConfiguredMoonraker} from '../moonraker/configured-server.ts';
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
export interface ProductHostFactory {
 (signal:AbortSignal):Promise<ProductHostProfile>;
 /** Explicit process dependency ownership. Must also provide final cleanup. */
 readonly serverLifetime?:'process';
 /** Process resources outlive profiles. The host invokes this only after the
  * final generation retires, including startup and retirement failures. */
 close?():Promise<void>;
}
/** One process lifetime: load -> connect -> listen -> stop -> release dependencies.
 * Hardware stop does not close the API: keep durable outcomes and unavailable
 * hardware status observable until explicit process shutdown. No automatic reconnect or replay. */
export async function runProductHost(factory:ProductHostFactory,signal:AbortSignal,ready:(address:AddressInfo)=>void,control?:ProductHostControl):Promise<void>{
 control??=new ProductHostControl();
 signal.throwIfAborted();if(typeof factory!=='function'||typeof ready!=='function'||factory.close!==undefined&&typeof factory.close!=='function'||factory.serverLifetime!==undefined&&factory.serverLifetime!=='process'||factory.serverLifetime==='process'&&!factory.close)throw new TypeError('Invalid product host callbacks');
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
  while(!signal.aborted){
   profile=await factory(signal);
   if(!profile||typeof profile.release!=='function')throw new TypeError('Machine profile must own dependency cleanup');
   await control.configure(profile.recoveryJournal);signal.throwIfAborted();service=await startConfiguredMachineService(profile.reader,profile.policies,profile.product,{...profile.options,serverLifetime:processLifetime?'process':'generation',existingServer:processServer,server:{...profile.options.server,temperatureStore:{...profile.options.server.temperatureStore,previous:temperatureHistory},productHostControl:control}},signal);
   if(processLifetime)processServer??=service.server;
   temperatureHistory=undefined;
   service.printer.group.assertActive();signal.throwIfAborted();
   const generation=service,change=Promise.withResolvers<void>();let requested:ReturnType<typeof Promise.withResolvers<void>>|undefined;
   const validate=()=>{
    signal.throwIfAborted();const printer=generation.printer,state=printer.controller.state,gate=printer.maintenanceGate.status;
    if(!['idle','completed','cancelled','failed'].includes(state)||printer.controller.pendingDeviceActions||printer.controller.safeStopPending||gate.activities||gate.maintenance||printer.group.status.state==='failed')throw new Error('Reinitialization requires a quiescent printer and confirmed physical stop');
   };
   detach=control.attach(()=>{validate();const printer=generation.printer;
    // Fence producers synchronously before yielding to any HTTP request.
    printer.maintenanceGate.invalidate();requested=Promise.withResolvers<void>();activeRequest=requested;change.resolve();return requested.promise;
   },validate);
   ready({...service.address});completion?.resolve();completion=undefined;
   await Promise.race([stopped.promise,change.promise]);
   completion=requested;activeRequest=undefined;await closeGeneration();
   if(!requested)break;
  }
 }catch(error){
  if(!signal.aborted||error!==signal.reason){if(error instanceof AggregateError&&error.message==='Product generation cleanup failed')errors.push(...error.errors);else errors.push(error);}
  try{await closeGeneration();}catch(cleanup){if(cleanup instanceof AggregateError)errors.push(...cleanup.errors);else errors.push(cleanup);}
  completion??=activeRequest;
  if(completion){completion.reject(new AggregateError(errors,'Product reinitialization failed'));completion=activeRequest=undefined;}
  // A failed replacement must stay observable. Only explicit process shutdown
  // closes the retained listener; there is no automatic device retry or replay.
  if(processServer&&!signal.aborted)await stopped.promise;
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
