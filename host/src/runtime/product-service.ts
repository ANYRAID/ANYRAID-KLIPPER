import {registerNativeProbe} from '../moonraker/native-probe.ts';
import {BedMeshProfiles} from '../motion/bed-mesh-profiles.ts';
import {registerNativeConfiguration} from '../moonraker/native-configuration.ts';
import {productObjects} from './product-objects.ts';
import type {NativeHostSnapshot} from '../moonraker/native-host-status.ts';
import {connectProductPrinter,type ProductPrinterOptions} from './product-printer.ts';
import type {ConfiguredPrinterOptions} from './configured-printer.ts';
import {ConfiguredMoonraker,type ConfiguredServerOptions} from '../moonraker/configured-server.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUConnection} from './mcu-group.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import {planLinearPrinter,type LinearPrinterPolicy} from '../config/linear-printer.ts';
import {configuredMCUConnections,type MCUMachinePolicy} from './configured-mcu-connections.ts';
export interface ConfiguredProductServiceOptions extends ProductServiceOptions {
 machine:Omit<LinearPrinterPolicy,'mcus'>;
 hardware?:Omit<ConfiguredPrinterOptions['hardware'],'motion'>;
 print:ConfiguredPrinterOptions['print'];
}
/** Configuration-driven native service. Physical stop, file access, lifecycle,
 * authorization and durable journal policies remain explicit machine inputs. */
export function startConfiguredProductService(reader:ConfigurationReader,policies:ReadonlyMap<string,MCUMachinePolicy>,product:ProductPrinterOptions,options:ConfiguredProductServiceOptions,signal:AbortSignal){
 signal.throwIfAborted();
 const connections=configuredMCUConnections(reader,policies);
 const plan=planLinearPrinter(reader,{...options.machine,mcus:connections.map(c=>c.id)});
 const printerOptions:ConfiguredPrinterOptions={hardware:{...options.hardware,motion:plan.motion},motion:plan.initial,linear:plan.linear,print:options.print};
 return startProductService(reader,connections,'mcu',plan.layout,printerOptions,product,options,signal);
}
export interface ProductServiceOptions {
 configPath:string;
 server:Omit<ConfiguredServerOptions,'productPrint'|'productPressure'|'maintenanceGate'|'nativeHost'|'nativeObjects'|'nativePrinterIdentity'>;
}
/** Start native hardware, durable print control and the authorized Moonraker
 * listener as one owner. Journal remains external; server component ownership
 * follows ConfiguredMoonraker.load. No automatic reconnect or print replay. */
export async function startProductService(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,printerOptions:ConfiguredPrinterOptions,product:ProductPrinterOptions,options:ProductServiceOptions,signal:AbortSignal){
 signal.throwIfAborted();const configPath=options.configPath,serverOptions={...options.server};
 const printer=await connectProductPrinter(reader,connections,primaryId,layout,printerOptions,product,signal);
 let server:ConfiguredMoonraker|undefined,closing:Promise<void>|undefined;let closeConfiguration:(()=>Promise<void>)|undefined,closeProbe:(()=>Promise<void>)|undefined;
 const nativeHost=():NativeHostSnapshot=>{const group=printer.group.status,gate=printer.maintenanceGate.status;return {group_state:group.state,hardware_state:printer.hardware.status.state,print_state:printer.controller.state,homed_axes:printer.linear.kinematics.status.homedAxes,closing:!!closing,admission_closed:gate.closed,maintenance:gate.maintenance,mcus:group.devices.map(({id,state})=>({id,state:state as NativeHostSnapshot['mcus'][number]['state']}))};};
 const close=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;
  const configurationClosed=closeConfiguration?.(),probeClosed=closeProbe?.();
  const jobs:Promise<void>[]=[];if(probeClosed)jobs.push(probeClosed);if(configurationClosed)jobs.push(configurationClosed);for(const stop of [()=>server?.close(),()=>printer.close()])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Product service cleanup failed'));else done.resolve();});return closing;
 };
 // Loading can still return an owner after cancellation. Only trigger printer
 // stop here; the sequential catch below closes any late server before rejecting.
 const aborted=()=>{void printer.close().catch(()=>{});void server?.close().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  signal.throwIfAborted();
  server=await ConfiguredMoonraker.load(configPath,{...serverOptions,productPrint:printer.controller,productPressure:printer.print.gcode.pressureAdvance,maintenanceGate:printer.maintenanceGate,nativePrinterIdentity:serverOptions.productPrintCompatibility?{configFile:reader.source.primaryFile,softwareVersion:serverOptions.information.version}:undefined,nativeHost,nativeObjects:productObjects(printer,nativeHost,serverOptions.nativeUploads?id=>serverOptions.nativeUploads!.filename(id):undefined)});
  signal.throwIfAborted();printer.group.assertActive();
  if(product.configurationSession)closeConfiguration=registerNativeConfiguration(server.endpoints,product.configurationSession,printer.maintenanceGate,new BedMeshProfiles(reader),{current:()=>printer.linear.port.currentBedMesh(),idle:()=>['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves});
  if(reader.hasSection('probe')){
   const minimum=reader.section('stepper_z').getFloat('position_min',{defaultValue:0});
   closeProbe=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&printer.linear.kinematics.status.homedAxes==='xyz',measure:async s=>{const r=await printer.linear.port.measureProbe(minimum,s);return {position:[...r.position],bed_position:[...r.bedPosition],samples:r.samples.map(p=>[...p]),retries:r.retries,attempts:r.attempts};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()});
  }
  const address=await server.start();signal.throwIfAborted();printer.group.assertActive();
  return Object.freeze({printer,server,address,close});
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Product service startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',aborted);}
}
