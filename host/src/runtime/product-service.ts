import {registerNativeAdaptiveMesh} from '../moonraker/native-adaptive-mesh.ts';
import {registerNativeBedMeshSelection} from '../moonraker/native-bed-mesh-selection.ts';
import {planProbeGrid,buildProbeGridMesh} from '../homing/probe-grid.ts';
import {readDeltaMotionConfiguration} from '../config/delta-motion.ts';
import {readDeltaCalibrationPlan} from '../config/delta-calibration-plan.ts';
import {readDeltaCalibrationState} from '../config/delta-calibration-state.ts';
import {registerNativeDeltaCalibration} from '../moonraker/native-delta-calibration.ts';
import {connectDeltaProductPrinter} from './product-delta-printer.ts';
import type {ConfiguredDeltaPrinterOptions} from './configured-delta-printer.ts';
import {planDeltaPrinter} from '../config/delta-printer.ts';
import {readBedScrews} from '../config/bed-screws.ts';
import {registerNativeBedScrews} from '../moonraker/native-bed-screws.ts';
import {ScrewsCalibrationStatus} from '../motion/screws-status.ts';
import {calculateScrewTilt} from '../motion/screws-tilt.ts';
import {readScrewsTilt} from '../config/screws-tilt.ts';
import {registerNativeScrewsTilt} from '../moonraker/native-screws-tilt.ts';
import {registerNativeSkewSave} from '../moonraker/native-skew-save.ts';
import {registerNativeSkew} from '../moonraker/native-skew.ts';
import {readSkewProfiles} from '../config/skew.ts';
import {readQuadGantry} from '../config/quad-gantry.ts';
import {readZTilt} from '../config/z-tilt.ts';
import {registerNativeZAdjustment} from '../moonraker/native-z-adjustment.ts';
import {registerNativeObjectCancellation} from '../moonraker/native-object-cancel.ts';
import {registerNativeZOffset} from '../moonraker/native-z-offset.ts';
import {registerNativeZEndstop} from '../moonraker/native-z-endstop.ts';
import {registerManualProbe} from '../moonraker/native-manual-probe.ts';
import {registerManualBedTilt} from '../moonraker/native-manual-bed-tilt.ts';
import {readBedTilt} from '../config/bed-tilt.ts';
import {registerNativeBedTiltSave} from '../moonraker/native-bed-tilt.ts';
import {registerNativeEndstopPhase} from '../moonraker/native-endstop-phase.ts';
import {registerNativeDriverCurrent} from '../moonraker/native-driver-current.ts';
import {registerNativeIdleSettings} from '../moonraker/native-idle-settings.ts';
import {registerNativeTemperatureFans} from '../moonraker/native-temperature-fan.ts';
import {readProbeGrid} from '../config/probe-grid.ts';
import {readNativeBedMesh} from '../config/native-bed-mesh.ts';
import {registerNativeProbe} from '../moonraker/native-probe.ts';
import {BedMeshProfiles} from '../motion/bed-mesh-profiles.ts';
import {registerNativeConfiguration} from '../moonraker/native-configuration.ts';
import {productObjects,type ProductServicePrinter} from './product-objects.ts';
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
/** Select the configured machine for every host generation, including restart. */
export function startConfiguredMachineService(reader:ConfigurationReader,policies:ReadonlyMap<string,MCUMachinePolicy>,product:ProductPrinterOptions,options:ConfiguredProductServiceOptions,signal:AbortSignal){
 signal.throwIfAborted();
 return reader.section('printer').get('kinematics')==='delta'
  ?startConfiguredDeltaProductService(reader,policies,product,options,signal)
  :startConfiguredProductService(reader,policies,product,options,signal);
}
/** Start native hardware, durable print control and the authorized Moonraker
 * listener as one owner. Journal remains external; server component ownership
 * follows ConfiguredMoonraker.load. No automatic reconnect or print replay. */
export function startProductService(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,printerOptions:ConfiguredPrinterOptions,product:ProductPrinterOptions,options:ProductServiceOptions,signal:AbortSignal){
 return startMachineProductService(reader,product,options,signal,()=>connectProductPrinter(reader,connections,primaryId,layout,printerOptions,product,signal));
}
export function startDeltaProductService(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,printerOptions:ConfiguredDeltaPrinterOptions,product:ProductPrinterOptions,options:ProductServiceOptions,signal:AbortSignal){
 return startMachineProductService(reader,product,options,signal,()=>connectDeltaProductPrinter(reader,connections,primaryId,layout,printerOptions,product,signal));
}
export function startConfiguredDeltaProductService(reader:ConfigurationReader,policies:ReadonlyMap<string,MCUMachinePolicy>,product:ProductPrinterOptions,options:ConfiguredProductServiceOptions,signal:AbortSignal){
 signal.throwIfAborted();const connections=configuredMCUConnections(reader,policies),plan=planDeltaPrinter(reader,{...options.machine,mcus:connections.map(c=>c.id)});
 return startDeltaProductService(reader,connections,'mcu',plan.layout,{hardware:{...options.hardware,motion:plan.motion},motion:plan.initial,delta:plan.delta,print:options.print},product,options,signal);
}
async function startMachineProductService<T extends ProductServicePrinter>(reader:ConfigurationReader,product:ProductPrinterOptions,options:ProductServiceOptions,signal:AbortSignal,connect:()=>Promise<T>){
 signal.throwIfAborted();const bedScrews=readBedScrews(reader),screws=readScrewsTilt(reader),zTilt=readZTilt(reader),quad=readQuadGantry(reader);const configPath=options.configPath,serverOptions={...options.server};
 const screwsStatus=new ScrewsCalibrationStatus();
 const deltaPlan=readDeltaCalibrationPlan(reader),deltaState=readDeltaCalibrationState(reader);
 const printer=await connect();
 let closeDeltaCalibration:ReturnType<typeof registerNativeDeltaCalibration>|undefined;
 let closeAdaptiveMesh:(()=>Promise<void>)|undefined;
 let closeMeshSelection:(()=>Promise<void>)|undefined;
 let closeManualMesh:(()=>Promise<void>)|undefined;
 let closeManualDelta:(()=>Promise<void>)|undefined;
 let closeBedScrews:(()=>Promise<void>)|undefined;
 let closeManualScrews:(()=>Promise<void>)|undefined;
 let closeScrews:(()=>Promise<void>)|undefined;
 let closeQuad:(()=>Promise<void>)|undefined;
 let closeTemperatureFans:(()=>void)|undefined;
 let closeSkewSave:(()=>Promise<void>)|undefined;
 let closeSkew:(()=>Promise<void>)|undefined;
 let closeZTilt:(()=>Promise<void>)|undefined;
 let closeZAdjustment:(()=>Promise<void>)|undefined;
 let closeObjectCancellation:(()=>void)|undefined;
 let closeZOffset:(()=>Promise<void>)|undefined;
 let closeZEndstop:(()=>Promise<void>)|undefined;
 let closeManualProbe:(()=>Promise<void>)|undefined;
 let closeManualTilt:(()=>Promise<void>)|undefined;
 let closeTilt:(()=>Promise<void>)|undefined,closeTiltSave:(()=>Promise<void>)|undefined;
 let server:ConfiguredMoonraker|undefined,closing:Promise<void>|undefined;let closeEndstopPhase:(()=>Promise<void>)|undefined;let closeDriverCurrent:(()=>Promise<void>)|undefined;let closeIdleSettings:(()=>void)|undefined;let closeConfiguration:(()=>Promise<void>)|undefined,closeProbe:(()=>Promise<void>)|undefined,closeGrid:(()=>Promise<void>)|undefined,closeHome:(()=>Promise<void>)|undefined;
 const nativeHost=():NativeHostSnapshot=>{const group=printer.group.status,gate=printer.maintenanceGate.status;return {group_state:group.state,hardware_state:printer.hardware.status.state,print_state:printer.controller.state,homed_axes:printer.machine.kinematics.status.homedAxes,closing:!!closing,admission_closed:gate.closed,maintenance:gate.maintenance,mcus:group.devices.map(({id,state})=>({id,state:state as NativeHostSnapshot['mcus'][number]['state']}))};};
 const close=():Promise<void>=>{
  if(closing)return closing;const done=Promise.withResolvers<void>();closing=done.promise;
  closeIdleSettings?.();
  closeTemperatureFans?.();
  closeObjectCancellation?.();
  const driverCurrentClosed=closeDriverCurrent?.(),endstopPhaseClosed=closeEndstopPhase?.();
  const configurationClosed=closeConfiguration?.(),probeClosed=closeProbe?.(),gridClosed=closeGrid?.(),homeClosed=closeHome?.();
  const jobs:Promise<void>[]=[];if(closeAdaptiveMesh)jobs.push(closeAdaptiveMesh());if(closeMeshSelection)jobs.push(closeMeshSelection());if(closeManualMesh)jobs.push(closeManualMesh());if(closeManualDelta)jobs.push(closeManualDelta());if(closeDeltaCalibration)jobs.push(closeDeltaCalibration());if(closeBedScrews)jobs.push(closeBedScrews());if(closeScrews)jobs.push(closeScrews());if(closeManualScrews)jobs.push(closeManualScrews());if(closeSkew)jobs.push(closeSkew());if(closeSkewSave)jobs.push(closeSkewSave());if(closeQuad)jobs.push(closeQuad());if(closeZTilt)jobs.push(closeZTilt());if(closeZAdjustment)jobs.push(closeZAdjustment());if(closeZOffset)jobs.push(closeZOffset());if(closeZEndstop)jobs.push(closeZEndstop());if(closeManualProbe)jobs.push(closeManualProbe());if(closeManualTilt)jobs.push(closeManualTilt());if(closeTilt)jobs.push(closeTilt());if(closeTiltSave)jobs.push(closeTiltSave());if(endstopPhaseClosed)jobs.push(endstopPhaseClosed);if(driverCurrentClosed)jobs.push(driverCurrentClosed);if(homeClosed)jobs.push(homeClosed);if(gridClosed)jobs.push(gridClosed);if(probeClosed)jobs.push(probeClosed);if(configurationClosed)jobs.push(configurationClosed);for(const stop of [()=>server?.close(),()=>printer.close()])try{jobs.push(Promise.resolve(stop()));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Product service cleanup failed'));else done.resolve();});return closing;
 };
 // Loading can still return an owner after cancellation. Only trigger printer
 // stop here; the sequential catch below closes any late server before rejecting.
 const aborted=()=>{void printer.close().catch(()=>{});void server?.close().catch(()=>{});};signal.addEventListener('abort',aborted,{once:true});
 try{
  signal.throwIfAborted();
  if(zTilt){const z=printer.initial.emitters.filter(e=>e.mode==='z');if(z.length!==zTilt.motors.length||z.some(e=>!zTilt.motors.some(m=>m.id===e.id))||!printer.hardware.plan.homing.some(h=>h.section==='probe'||h.section==='bltouch'))throw new Error('Configured Z tilt hardware ownership differs');}
  if(quad){const z=printer.initial.emitters.filter(e=>e.mode==='z');if(z.length!==quad.motorIds.length||z.some(e=>!quad.motorIds.includes(e.id))||!printer.hardware.plan.homing.some(h=>h.section==='probe'||h.section==='bltouch'))throw new Error('Configured Quad gantry hardware ownership differs');}
  server=await ConfiguredMoonraker.load(configPath,{...serverOptions,productPrint:printer.controller,productPressure:printer.print.gcode.pressureAdvance,maintenanceGate:printer.maintenanceGate,nativePrinterIdentity:serverOptions.productPrintCompatibility?{configFile:reader.source.primaryFile,softwareVersion:serverOptions.information.version}:undefined,nativeHost,nativeObjects:productObjects(printer,nativeHost,serverOptions.nativeUploads?id=>serverOptions.nativeUploads!.filename(id):undefined,!!zTilt,!!quad,screws?()=>screwsStatus.status:undefined)});
  signal.throwIfAborted();printer.group.assertActive();
  if(printer.print.gcode.objects)closeObjectCancellation=registerNativeObjectCancellation(server.endpoints,printer.print.gcode.objects,{
   snapshot:()=>({requestId:printer.controller.currentRequest?.requestId??null,state:printer.controller.state,stateToken:printer.controller.stateToken,available:!closing&&!printer.maintenanceGate.status.closed&&!printer.controller.safeStopPending}),
   assertActive:()=>printer.machine.port.assertActive()
  });
  closeDriverCurrent=registerNativeDriverCurrent(server.endpoints,printer.maintenanceGate,{
   snapshot:()=>printer.hardware.drivers.map(d=>({name:d.section,revision:d.current.revision,max_current:d.current.maxCurrent,run_current:d.current.current.runCurrent,hold_current:d.current.current.holdCurrent})),
   idle:()=>printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves,
   set:async(name,change,signal)=>{const driver=printer.hardware.drivers.find(d=>d.section===name);if(!driver)throw new Error('Unknown current driver');await printer.print.gcode.dispatch.runExclusive(async s=>{await printer.machine.port.drain(s);await driver.current.set(change,s);},signal);},
   fail:error=>{void printer.hardware.close(error).catch(()=>{});}
  });
  const skewProfiles=readSkewProfiles(reader);
  if(skewProfiles)closeSkewSave=registerNativeSkewSave(server.endpoints,printer.maintenanceGate,{snapshot:()=>printer.machine.port.skewStatus,idle:()=>!closing&&printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy},product.configurationSession);
  if(skewProfiles)closeSkew=registerNativeSkew(server.endpoints,printer.maintenanceGate,skewProfiles,{
   snapshot:()=>printer.machine.port.skewStatus,
   idle:()=>!closing&&printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy,
   set:async(factors,signal)=>{await printer.print.gcode.dispatch.runExclusive(async s=>{await printer.machine.port.setSkew(factors,s);printer.print.gcode.coordinates.resetPosition();},signal);},
   fail:error=>printer.hardware.close(error)
  });
  closeEndstopPhase=registerNativeEndstopPhase(server.endpoints,printer.maintenanceGate,{snapshot:()=>printer.machine.port.endstopPhaseCalibration(),idle:()=>printer.hardware.status.state==='ready'&&['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy},product.configurationSession);
  if(screws&&(reader.hasSection('probe')||reader.hasSection('bltouch')))closeScrews=registerNativeScrewsTilt(server.endpoints,printer.maintenanceGate,{
   idle:()=>!closing&&printer.hardware.status.state==='ready'&&['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&printer.machine.kinematics.status.homedAxes==='xyz',
   measure:async(signal,direction,maximumDeviation)=>{screwsStatus.begin(maximumDeviation);const result=await printer.machine.port.measureScrewsTilt(screws,reader.section('stepper_z').getFloat('position_min',{defaultValue:0}),signal,direction,maximumDeviation);screwsStatus.complete(result);return result;},
   synchronize:()=>printer.print.gcode.coordinates.resetPosition(),fail:error=>{screwsStatus.fail();return printer.hardware.close(error);}
  });
  closeIdleSettings=registerNativeIdleSettings(server.endpoints,printer.idleTimeout,()=>!printer.maintenanceGate.status.closed&&!printer.maintenanceGate.status.maintenance);
  closeTemperatureFans=registerNativeTemperatureFans(server.endpoints,printer.hardware.temperatureFans,()=>!closing&&printer.hardware.status.state==='ready'&&!printer.maintenanceGate.status.closed&&!printer.maintenanceGate.status.maintenance&&!printer.controller.safeStopPending);
  if(product.configurationSession)closeConfiguration=registerNativeConfiguration(server.endpoints,product.configurationSession,printer.maintenanceGate,new BedMeshProfiles(reader),{fileBound:()=>printer.machine.port.bedMeshFileBound,current:()=>printer.machine.port.currentBedMesh(),idle:()=>['idle','completed','cancelled'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves});
  closeHome=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&!printer.print.gcode.homing.status.busy,measure:async s=>{await printer.print.gcode.homing.home([0,1,2],s);return {homed_axes:printer.machine.kinematics.status.homedAxes,position:[...printer.machine.port.homingPosition()]};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'home');
  const tilt=readBedTilt(reader),tiltIdle=()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&printer.machine.kinematics.status.homedAxes==='xyz';
  const manualGrid=readProbeGrid(reader),manualMeshConfiguration=readNativeBedMesh(reader);
  if(manualMeshConfiguration)closeMeshSelection=registerNativeBedMeshSelection(server.endpoints,printer.maintenanceGate,manualMeshConfiguration.profiles,{snapshot:()=>({revision:printer.machine.port.bedMeshStatus,profile:String(printer.machine.port.bedMeshStatus.profile_name)}),idle:tiltIdle,set:async(mesh,name,s)=>{await printer.machine.port.replaceBedMesh(mesh,manualMeshConfiguration.settings,s,name);printer.print.gcode.coordinates.resetPosition();},fail:cause=>printer.machine.port.motorOff(cause)});
  if(manualGrid&&manualMeshConfiguration){
   // Manual contacts use the nozzle directly, with no probe offsets or zero reference.
   const plan=planProbeGrid({...manualGrid,zeroReference:undefined},[0,0,0]);
   closeManualMesh=registerManualBedTilt(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),apply:async(samples,s)=>{const mesh=buildProbeGridMesh(plan,samples.map(p=>p[2]));await printer.machine.port.replaceBedMesh(mesh,manualMeshConfiguration.settings,s,'measured');return {profile:'measured',probe_count:[mesh.params.x_count,mesh.params.y_count],range:mesh.range(),persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},{points:plan.points.map(p=>[p.nozzleX,p.nozzleY] as [number,number]),horizontalHeight:plan.horizontalHeight,travelSpeed:plan.travelSpeed},300000,'bed_mesh');
  }
  closeZAdjustment=registerNativeZAdjustment(server.endpoints,printer.maintenanceGate,{
   snapshot:()=>({offset:printer.print.gcode.coordinates.zOffset.value,revision:printer.print.gcode.coordinates.zOffset.revision,position:printer.print.gcode.coordinates.state.position,printToken:printer.controller.stateToken,minimum:printer.machine.kinematics.status.axisMinimum[2],maximum:printer.machine.kinematics.status.axisMaximum[2]}),
   idle:()=>tiltIdle()&&printer.hardware.status.state==='ready',
   adjust:(delta,signal)=>printer.print.gcode.dispatch.runExclusive(async s=>{await printer.machine.port.drain(s);printer.print.gcode.coordinates.execute('SET_GCODE_OFFSET',{Z_ADJUST:delta,MOVE:1,MOVE_SPEED:5});await printer.machine.port.drain(s);},signal),
   stop:cause=>printer.machine.port.motorOff(cause)
  });
  if(deltaPlan){
   const kinematics=readDeltaMotionConfiguration(reader).kinematics;
   closeDeltaCalibration=registerNativeDeltaCalibration(server.endpoints,printer.maintenanceGate,{captureStable:async s=>{await printer.machine.port.drain(s);s.throwIfAborted();const p=printer.machine.port.manualProbePosition();return kinematics.stablePosition([p[0],p[1],p[2]]);},canProbe:reader.hasSection('probe')||reader.hasSection('bltouch'),restored:()=>({geometry:kinematics.calibrationGeometry,...deltaState}),validateGeometry:g=>kinematics.validateCalibrationGeometry(g),idle:tiltIdle,measure:async s=>({geometry:kinematics.calibrationGeometry,probes:await printer.machine.port.measureDeltaCalibration(deltaPlan,kinematics.status.axisMinimum[2],s),manual:deltaState.manual,distances:deltaState.distances}),synchronize:()=>printer.print.gcode.coordinates.resetPosition()},product.configurationSession);
   const deltaOwner=closeDeltaCalibration;
   closeManualDelta=registerManualBedTilt(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),apply:async(samples,s)=>deltaOwner.acceptManual({geometry:kinematics.calibrationGeometry,probes:samples.map(p=>({height:0,stable:kinematics.stablePosition([p[0],p[1],p[2]])})),manual:deltaState.manual,distances:deltaState.distances},s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},deltaPlan,300000,'delta');
  }
  if(bedScrews)closeBedScrews=registerNativeBedScrews(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,planned:()=>printer.machine.port.homingPosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},bedScrews);
  if(screws)closeManualScrews=registerManualBedTilt(server.endpoints,printer.maintenanceGate,{begin:selection=>screwsStatus.begin(selection.maximumDeviation),idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),apply:async(samples,s,selection)=>{s.throwIfAborted();const result=calculateScrewTilt(samples.map(p=>p[2]),screws.thread,selection.direction,selection.maximumDeviation);screwsStatus.complete(result);return {...result,samples:samples.map(p=>[...p]),names:[...screws.names],thread:screws.thread,persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>{screwsStatus.fail();return printer.machine.port.motorOff(cause);},subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},screws,300000,'screws_tilt');
  closeManualProbe=registerManualProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)});
  if(reader.hasSection('stepper_z')&&reader.section('stepper_z').hasOption('position_endstop')&&reader.section('stepper_z').get('endstop_pin')!=='probe:z_virtual_endstop')closeZEndstop=registerNativeZEndstop(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},reader.section('stepper_z').getFloat('position_endstop'),product.configurationSession);
  if(closeZEndstop)closeZOffset=registerNativeZOffset(server.endpoints,printer.maintenanceGate,{offset:()=>printer.print.gcode.coordinates.zOffset,idle:tiltIdle},reader.section('stepper_z').getFloat('position_endstop'),printer.machine.kinematics.status.axisMinimum[2],printer.machine.kinematics.status.axisMaximum[2],product.configurationSession);
  if(zTilt)closeZTilt=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,measure:async s=>{const r=await printer.machine.port.calibrateZTilt(zTilt,reader.section('stepper_z').getFloat('position_min',{defaultValue:0}),s);return {passes:r.passes,samples:r.samples,measured_range:r.measuredRange,tolerance_satisfied:r.toleranceSatisfied,adjustments:r.adjustment.adjustments.map(m=>({...m})),final_z:r.adjustment.finalZ,persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'z_tilt');
  if(quad)closeQuad=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,measure:async s=>{const r=await printer.machine.port.calibrateQuadGantry(quad,reader.section('stepper_z').getFloat('position_min',{defaultValue:0}),s);return {passes:r.passes,samples:r.samples,measured_range:r.measuredRange,tolerance_satisfied:r.toleranceSatisfied,adjustments:r.adjustment.adjustments.map(m=>({...m})),final_z:r.adjustment.finalZ,persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'quad_gantry_level');
  if(tilt){
   if(tilt.calibration)closeManualTilt=registerManualBedTilt(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,travelHeight:(current,height)=>printer.machine.port.manualCalibrationTravelHeight(current,height),preflight:(points,height,speed)=>printer.machine.port.preflightManualCalibration(points,height,speed),planned:()=>printer.machine.port.homingPosition(),measured:()=>printer.machine.port.manualProbePosition(),limits:printer.machine.kinematics.status,move:(p,speed,s)=>printer.machine.port.homingTravel(p,speed,s),apply:async(samples,s)=>({...await printer.machine.port.applyManualBedTilt(samples,s),persisted:false}),synchronize:()=>printer.print.gcode.coordinates.resetPosition(),stop:cause=>printer.machine.port.motorOff(cause),subscribeStop:listener=>printer.machine.port.subscribeStop(listener)},tilt.calibration);
   closeTiltSave=registerNativeBedTiltSave(server.endpoints,printer.maintenanceGate,{snapshot:()=>printer.machine.port.bedTiltStatus,idle:tiltIdle},product.configurationSession);
   if(tilt.calibration&&(reader.hasSection('probe')||reader.hasSection('bltouch')))closeTilt=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:tiltIdle,measure:async s=>({...await printer.machine.port.calibrateBedTilt(tilt.calibration!,reader.section('stepper_z').getFloat('position_min',{defaultValue:0}),s),persisted:false}),synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'bed_tilt');
  }
  if(reader.hasSection('probe')||reader.hasSection('bltouch')){
   const minimum=printer.machine.kinematics.status.axisMinimum[2];
   const grid=readProbeGrid(reader),meshConfiguration=readNativeBedMesh(reader);
   if(grid&&meshConfiguration)closeAdaptiveMesh=registerNativeAdaptiveMesh(server.endpoints,printer.maintenanceGate,grid,{idle:tiltIdle,open:printer.print.openForCalibration,measure:(g,s)=>printer.machine.port.measureBedMesh(g,minimum,s),activate:async(mesh,identity,s)=>{await printer.machine.port.replaceBedMesh(mesh,meshConfiguration.settings,s,identity?'adaptive':'measured',identity);printer.print.gcode.coordinates.resetPosition();},fail:cause=>printer.machine.port.motorOff(cause)});
   if(grid&&meshConfiguration)closeGrid=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&printer.machine.kinematics.status.homedAxes==='xyz',measure:async s=>{const mesh=await printer.machine.port.measureBedMesh(grid,minimum,s);s.throwIfAborted();await printer.machine.port.replaceBedMesh(mesh,meshConfiguration.settings,s,'measured');return {profile:'measured',probe_count:[mesh.params.x_count,mesh.params.y_count],range:mesh.range(),persisted:false};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()},'bed_mesh');
   closeProbe=registerNativeProbe(server.endpoints,printer.maintenanceGate,{idle:()=>['idle','completed'].includes(printer.controller.state)&&!printer.controller.pendingDeviceActions&&!printer.controller.safeStopPending&&!printer.machine.port.status.busy&&!printer.machine.port.status.pendingMoves&&printer.machine.kinematics.status.homedAxes==='xyz',measure:async s=>{const r=await printer.machine.port.measureProbe(minimum,s);return {position:[...r.position],bed_position:[...r.bedPosition],samples:r.samples.map(p=>[...p]),retries:r.retries,attempts:r.attempts};},synchronize:()=>printer.print.gcode.coordinates.resetPosition()});
  }
  const address=await server.start();signal.throwIfAborted();printer.group.assertActive();
  return Object.freeze({printer,server,address,close});
 }catch(error){try{await close();}catch(cleanup){throw new AggregateError([error,cleanup],'Product service startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',aborted);}
}
