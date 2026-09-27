import {registerNativeZEndstop} from '../moonraker/native-z-endstop.ts';
import {registerManualProbe} from '../moonraker/native-manual-probe.ts';
import {registerManualBedTilt} from '../moonraker/native-manual-bed-tilt.ts';
import {readBedTilt} from '../config/bed-tilt.ts';
import {registerNativeBedTiltSave} from '../moonraker/native-bed-tilt.ts';
import {registerNativeEndstopPhase} from '../moonraker/native-endstop-phase.ts';
import {registerNativeDriverCurrent} from '../moonraker/native-driver-current.ts';
import {registerNativeIdleSettings} from '../moonraker/native-idle-settings.ts';
import {readProbeGrid} from '../config/probe-grid.ts';
import {readNativeBedMesh} from '../config/native-bed-mesh.ts';
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
 let closeZEndstop:(()=>Promise<void>)|undefined;
 let closeManualProbe:(()=>Promise<void>)|undefined;
 let closeManualTilt:(()=>Promise<void>)|undefined;
 let closeTilt:(()=>Promise<void>)|undefined,closeTiltSave:(()=>Promise<void>)|undefined;
 let server:ConfiguredMoonraker|undefined,closing:Promise<void>|undefined;let closeEndstopPhase:(()=>Promise<void>)|undefined;let closeDriverCurrent:(()=>Promise<void>)|undefined;let closeIdleSettings:(()=>void)|undefined;let closeConfiguration:(()=>Promise<void>)|undefined,closeProbe:(()=>Promise<void>)|undefined,closeGrid:(()=>Promise<void>)|undefined,closeHome:(()=>Promise<void>)|undefined;
 const nativeHost=():NativeHostSnapshot=>{const group=printer.group.status,gate=printer.maintenanceGate.status;return {group_state:group.state,hardware_state:printer.hardware.status.state,print_state:printer.controller.state,homed_axes:printer.linear.kinematics.status.homedAxes,closing:!!closing,admission_closed:gate.closed,maintenance:gate.maintenance,mcus:group.devices.map(({id,state})=>({id,state:state as NativeHostSnapshot['mcus'][number]['state']}))};};
 const close=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;
  closeIdleSettings?.();
  const driverCurrentClosed=closeDriverCurrent?.(),endstopPhaseClosed=closeEndstopPhase?.();
  const configurationClosed=closeConfiguration?.(),probeClosed=closeProbe?.(),gridClosed=closeGrid?.(),homeClosed=closeHome?.();
  const jobs:Promise<void>[]=[];if(closeZEndstop)jobs.push(closeZEndstop());if(closeManualProbe)jobs.push(closeManualProbe());if(closeManualTilt)jobs.push(closeManualTilt());if(closeTilt)jobs.push(closeTilt());if(closeTiltSave)jobs.push(closeTiltSave());if(endstopPhaseClosed)jobs.push(endstopPhaseClosed);if(driverCurrentClosed)jobs.push(driverCurrentClosed);if(homeClosed)jobs.push(homeClosed);if(gridClosed)jobs.push(gridClosed);if(probeClosed)jobs.push(probeClosed);if(configurationClosed)jobs.push(configurationClosed);for(const stop of [()=>server?.close(),()=>printer.close()])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Product service cleanup failed'));else done.resolve();});return closing;
 };
 // Loading can still return an owner after cancellation. Only trigger printer
 // stop here; the sequential catch below closes any late server before rejecting.
 const aborted=()=>{void printer.close().catch(()=>{});void server?.close().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  signal.throwIfAborted();
  server=await ConfiguredMoonraker.load(configPath,{...serverOptions,productPrint:printer.controller,productPressure:printer.print.gcode.pressureAdvance,maintenanceGate:printer.maintenanceGate,nativePrinterIdentity:serverOptions.productPrintCompatibility?{configFile:reader.source.primaryFile,softwareVersion:serverOptions.information.version}:undefined,nativeHost,nativeObjects:productObjects(printer,nativeHost,serverOptions.nativeUploads?id=>serverOptions.nativeUploads!.filename(id):undefined)});
  signal.throwIfAborted();printer.group.assertActive();
  closeDriverCurrent=registerNativeDriverCurrent(server.endpoints,printer.maintenanceGate,{
   snapshot:()=>printer.hardware.drivers.map(d=>({name:d.section,revision:d.current.revision,max_current:d.current.maxCurrent,run_current:d.current.current.runCurrent,hold_current:d.current.current.holdCurrent})),
   idle:()=>printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves,
   set:async(name,change,signal)=>{const driver=printer.hardware.drivers.find(d=>d.section===name);if(!driver)throw new Error('Unknown current driver');await printer.print.gcode.dispatch.runExclusive(async s=>{await printer.linear.port.drain(s);await driver.current.set(change,s);},signal);},
   fail:error=>{void printer.hardware.close(error).catch(()=>{});}
  });
  closeEndstopPhase=registerNativeEndstopPhase(server.endpoints,printer.maintenanceGate,{snapshot:()=>printer.linear.port.endstopPhaseCalibration(),idle:()=>printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy},product.configurationSession);
  closeIdleSettings=registerNativeIdleSettings(server.endpoints,printer.idleTimeout,()=>!printer.maintenanceGate.status.closed&&!printer.maintenanceGate.status.maintenance);
  if(product.configurationSession)closeConfiguration=registerNativeConfiguration(server.endpoints,product.configurationSession,printer.maintenanceGate,new BedMeshProfiles(reader),{current:()=>printer.linear.port.currentBedMesh(),idle:()=>['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves});
  closeHome=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy,measure:async s=>{await printer.print.gcode.homing.home([0,1,2],s);return {homed_axes:printer.linear.kinematics.status.homedAxes,position:[...printer.linear.port.homingPosition()]};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'home');
  const tilt=readBedTilt(reader),tiltIdle=()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&printer.linear.kinematics.status.homedAxes==='xyz';
  closeManualProbe=registerManualProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,planned:()=>printer.linear.port.homingPosition(),measured:()=>printer.linear.port.manualProbePosition(),limits:printer.linear.kinematics.status,move:(p,speed,s)=>printer.linear.port.homingTravel(p,speed,s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.linear.port.motorOff(cause),subscribeStop:listener=>printer.linear.port.subscribeStop(listener)});
  if(reader.section('stepper_z').hasOption('position_endstop')&&reader.section('stepper_z').get('endstop_pin')!=='probe:z_virtual_endstop')closeZEndstop=registerNativeZEndstop(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,planned:()=>printer.linear.port.homingPosition(),measured:()=>printer.linear.port.manualProbePosition(),limits:printer.linear.kinematics.status,move:(p,speed,s)=>printer.linear.port.homingTravel(p,speed,s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.linear.port.motorOff(cause),subscribeStop:listener=>printer.linear.port.subscribeStop(listener)},reader.section('stepper_z').getFloat('position_endstop'),product.configurationSession);
  if(tilt){
   if(tilt.calibration)closeManualTilt=registerManualBedTilt(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,planned:()=>printer.linear.port.homingPosition(),measured:()=>printer.linear.port.manualProbePosition(),limits:printer.linear.kinematics.status,move:(p,speed,s)=>printer.linear.port.homingTravel(p,speed,s),apply:async(samples,s)=>({...await printer.linear.port.applyManualBedTilt(samples,s),persisted:false}),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.linear.port.motorOff(cause),subscribeStop:listener=>printer.linear.port.subscribeStop(listener)},tilt.calibration);
   closeTiltSave=registerNativeBedTiltSave(server.endpoints,printer.maintenanceGate,{snapshot:()=>printer.linear.port.bedTiltStatus,idle:tiltIdle},product.configurationSession);
   if(tilt.calibration&&(reader.hasSection('probe')||reader.hasSection('bltouch')))closeTilt=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,measure:async s=>({...await printer.linear.port.calibrateBedTilt(tilt.calibration!,reader.section('stepper_z').getFloat('position_min',{defaultValue:0}),s),persisted:false}),synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'bed_tilt');
  }
  if(reader.hasSection('probe')||reader.hasSection('bltouch')){
   const minimum=reader.section('stepper_z').getFloat('position_min',{defaultValue:0});
   const grid=readProbeGrid(reader),meshConfiguration=readNativeBedMesh(reader);
   if(grid&&meshConfiguration)closeGrid=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&printer.linear.kinematics.status.homedAxes==='xyz',measure:async s=>{const mesh=await printer.linear.port.measureBedMesh(grid,minimum,s);s.throwIfAborted();await printer.linear.port.replaceBedMesh(mesh,meshConfiguration.settings,s,'measured');return {profile:'measured',probe_count:[mesh.params.x_count,mesh.params.y_count],range:mesh.range(),persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'bed_mesh');
   closeProbe=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.linear.port.status.busy&&!printer.linear.port.status.pendingMoves&&printer.linear.kinematics.status.homedAxes==='xyz',measure:async s=>{const r=await printer.linear.port.measureProbe(minimum,s);return {position:[...r.position],bed_position:[...r.bedPosition],samples:r.samples.map(p=>[...p]),retries:r.retries,attempts:r.attempts};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()});
  }
  const address=await server.start();signal.throwIfAborted();printer.group.assertActive();
  return Object.freeze({printer,server,address,close});
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Product service startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',aborted);}
}
