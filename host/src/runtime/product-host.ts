import {startConfiguredProductService,type ConfiguredProductServiceOptions} from './product-service.ts';
import type {ProductPrinterOptions} from './product-printer.ts';
import type {MCUMachinePolicy} from './configured-mcu-connections.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {AddressInfo} from 'node:net';
/** Trusted machine integration, never supplied by an uploaded print file.
 * The factory cleans up its own partial failure. On success, resource lifetime
 * transfers to the host; release runs after all service owners have retired. */
export interface ProductHostProfile {
 reader:ConfigurationReader;
 policies:ReadonlyMap<string,MCUMachinePolicy>;
 product:ProductPrinterOptions;
 options:ConfiguredProductServiceOptions;
 release():Promise<void>;
}
export type ProductHostFactory=(signal:AbortSignal)=>Promise<ProductHostProfile>;
/** One process lifetime: load -> connect -> listen -> stop -> release dependencies.
 * No reconnect, job replay, forced process exit, or implicit machine policy. */
export async function runProductHost(factory:ProductHostFactory,signal:AbortSignal,ready:(address:AddressInfo)=>void):Promise<void>{
 signal.throwIfAborted();if(typeof factory!=='function'||typeof ready!=='function')throw new TypeError('Invalid product host callbacks');
 const stopped=Promise.withResolvers<void>(),abort=()=>stopped.resolve(),errors:unknown[]=[];
 let profile:ProductHostProfile|undefined,service:Awaited<ReturnType<typeof startConfiguredProductService>>|undefined,off=()=>{},fault:unknown,failed=false;
 signal.addEventListener('abort',abort,{once:true});
 try{
  profile=await factory(signal);
  if(!profile||typeof profile.release!=='function')throw new TypeError('Machine profile must own dependency cleanup');
  signal.throwIfAborted();
  service=await startConfiguredProductService(profile.reader,profile.policies,profile.product,profile.options,signal);
  off=service.printer.group.subscribeStop(cause=>{failed=true;fault=cause;stopped.resolve();});
  service.printer.group.assertActive();signal.throwIfAborted();ready({...service.address});
  await stopped.promise;if(failed)throw fault;
 }catch(error){if(!signal.aborted||error!==signal.reason||failed)errors.push(error);}
 finally{
  signal.removeEventListener('abort',abort);try{off();}catch(error){errors.push(error);}
  if(service)try{await service.close();}catch(error){errors.push(error);}
  if(profile&&typeof profile.release==='function')try{await profile.release();}catch(error){errors.push(error);}
 }
 if(errors.length===1)throw errors[0];if(errors.length)throw new AggregateError(errors,'Product host and resource cleanup failed');
}
