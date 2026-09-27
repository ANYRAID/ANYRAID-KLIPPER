import {tmc220xStatusReader} from '../drivers/tmc220x-status.ts';
import {nativePrinterState} from '../moonraker/native-printer-info.ts';
import {NativeObjects,type NativeObjectReader} from '../moonraker/native-objects.ts';
import {readNativeHostStatus,type NativeHostStatusSource} from '../moonraker/native-host-status.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {connectProductPrinter} from './product-printer.ts';
import {productDisplayStatus} from './product-display-status.ts';
import {productPrintStatus,productPauseStatus} from './product-print-status.ts';
/** Publish only fields backed by the assembled native owners. Missing fields
 * retain the query protocol's null behavior; durations come from the controller. */
export function productObjects(printer:Awaited<ReturnType<typeof connectProductPrinter>>,nativeHost:NativeHostStatusSource,filename?:(fileId:string)=>string):NativeObjects{
 const pressure=printer.print.gcode.pressureAdvance;
 const readers=new Map<string,NativeObjectReader>([
  ['webhooks',()=>nativePrinterState(readNativeHostStatus(nativeHost))],
  ['native_host',()=>readNativeHostStatus(nativeHost)],
  ['gcode_move',()=>printer.print.gcode.coordinates.objectStatus],
  ['virtual_sdcard',()=>printer.print.file.objectStatus],
  ['display_status',eventtime=>productDisplayStatus(printer.print.gcode.display,printer.controller.state,printer.print.file.objectStatus.progress,eventtime)],
  ['print_stats',()=>productPrintStatus(printer.controller,printer.print.gcode.layers,filename)],
  ['pause_resume',()=>productPauseStatus(printer.controller.state)],
  ['idle_timeout',()=>({...printer.idleTimeout.status,motors_releasable:printer.linear.port.canReleaseMotors})],
  ['toolhead',()=>{const k=printer.linear.kinematics.status;return {homed_axes:k.homedAxes,axis_minimum:[...k.axisMinimum,0],axis_maximum:[...k.axisMaximum,0],position:[...printer.linear.port.homingPosition()],extruder:pressure?.name??'extruder',...printer.linear.port.velocityStatus};}],
  ['heaters',()=>{const h=printer.hardware.heaters.status;return {available_heaters:h.available_heaters,available_sensors:h.available_sensors,available_monitors:[]};}],
 ]);
 if(printer.linear.port.bedTiltStatus)readers.set('bed_tilt',()=>printer.linear.port.bedTiltStatus!);
 const bedMesh=printer.print.gcode.bedMeshStatus;if(bedMesh)readers.set('bed_mesh',()=>bedMesh());
 const retraction=printer.print.gcode.retraction;if(retraction)readers.set('firmware_retraction',()=>({...retraction.status}));
 for(const [i,heater] of printer.hardware.plan.heaters.entries())readers.set(heater.section,()=>{
  const thermal=printer.hardware.analog[i].runtime.objectStatus;
  if(pressure?.name!==heater.section)return thermal;
  const accepted=pressure.pressureAdvance;
  return {...thermal,pressure_advance:accepted.advance,smooth_time:accepted.smoothTime};
 });
 const drivers=new Map<string,{model:string;current:Readonly<{runCurrent:number;holdCurrent:number}>}>([...printer.hardware.plan.tmcUarts.flatMap(u=>u.devices.map(d=>[d.model+' '+d.stepper,d] as const)),...printer.hardware.plan.tmcSpis.flatMap(b=>b.devices.map(({plan:d})=>[d.model+' '+d.stepper,d] as const))]);
 for(const driver of printer.hardware.drivers){const plan=drivers.get(driver.section);if(!plan)throw new Error('TMC status configuration owner missing');readers.set(driver.section,tmc220xStatusReader(plan,driver.monitor,()=>driver.current.current,()=>{const sample=driver.phase.sample;if(!sample)return null;const stepper=printer.hardware.plan.steppers.find(s=>s.section===driver.section.slice(driver.section.indexOf(' ')+1))!;return {offset:sample.offset,position:printer.linear.port.phaseOffsetPosition(stepper.emitter,sample.offset)};}));}
 for(const fan of printer.hardware.fans)readers.set(fan.section,()=>({speed:fan.runtime.status.speed,rpm:null}));
 for(const sensor of printer.filamentSensors)readers.set(sensor.section,()=>({...sensor.runtime.status}));
 return new NativeObjects(readers,serialClock.now);
}
