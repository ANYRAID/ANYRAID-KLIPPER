import type {NativeLinearHomingPort} from '../homing/native-linear-port.ts';
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
export type ProductServicePrinter=Omit<Awaited<ReturnType<typeof connectProductPrinter>>,'linear'|'machine'>&{machine:{port:NativeLinearHomingPort;kinematics:{readonly status:{homedAxes:string;axisMinimum:number[];axisMaximum:number[]}}}};
export function productObjects(printer:ProductServicePrinter,nativeHost:NativeHostStatusSource,filename:((fileId:string)=>string)|undefined=undefined,zTilt=false,quad=false,screws?:NativeObjectReader):NativeObjects{
 const pressure=printer.print.gcode.pressureAdvance;
 const readers=new Map<string,NativeObjectReader>([
  ['webhooks',()=>nativePrinterState(readNativeHostStatus(nativeHost))],
  ['native_host',()=>readNativeHostStatus(nativeHost)],
  ['gcode_move',()=>printer.print.gcode.coordinates.objectStatus],
  ['virtual_sdcard',()=>printer.print.file.objectStatus],
  ['display_status',eventtime=>productDisplayStatus(printer.print.gcode.display,printer.controller.state,printer.print.file.objectStatus.progress,eventtime)],
  ['print_stats',()=>productPrintStatus(printer.controller,printer.print.gcode.layers,filename)],
  ['pause_resume',()=>productPauseStatus(printer.controller.state)],
  ['idle_timeout',()=>({...printer.idleTimeout.status,motors_releasable:printer.machine.port.canReleaseMotors})],
  ['toolhead',()=>{const k=printer.machine.kinematics.status;return {homed_axes:k.homedAxes,axis_minimum:[...k.axisMinimum,0],axis_maximum:[...k.axisMaximum,0],position:(()=>{const p=printer.machine.port.homingPosition();return [p[0],p[1],p[2],p[3+(printer.print.gcode.tools?.active??0)]];})(),extruder:pressure?.name??'extruder',...printer.machine.port.velocityStatus};}],
  ['heaters',()=>{const h=printer.hardware.heaters.status;return {available_heaters:h.available_heaters,available_sensors:h.available_sensors,available_monitors:[]};}],
 ]);
 if(screws)readers.set('screws_tilt_adjust',screws);
 if(quad)readers.set('quad_gantry_level',()=>printer.machine.port.quadGantryStatus);
 if(zTilt)readers.set('z_tilt',()=>printer.machine.port.zTiltStatus);
 if(printer.machine.port.bedTiltStatus)readers.set('bed_tilt',()=>printer.machine.port.bedTiltStatus!);
 const bedMesh=printer.print.gcode.bedMeshStatus;if(bedMesh)readers.set('bed_mesh',()=>bedMesh());
 const objects=printer.print.gcode.objects;if(objects)readers.set('exclude_object',()=>objects.status);
 const retraction=printer.print.gcode.retraction;if(retraction)readers.set('firmware_retraction',()=>({...printer.print.gcode.retraction!.status}));
 for(const heater of printer.hardware.thermal)readers.set(heater.section,()=>{
  const thermal=heater.runtime.objectStatus;
  const tool=printer.print.gcode.toolBindings.find(t=>t.name===heater.section);if(!tool&&pressure?.name!==heater.section)return thermal;
  const accepted=tool?printer.machine.port.pressureAdvanceSettings(tool.stepper):pressure!.pressureAdvance;
  return {...thermal,pressure_advance:accepted.advance,smooth_time:accepted.smoothTime};
 });
 const drivers=new Map<string,{model:string;current:Readonly<{runCurrent:number;holdCurrent:number}>}>([...printer.hardware.plan.tmcUarts.flatMap(u=>u.devices.map(d=>[d.model+' '+d.stepper,d] as const)),...printer.hardware.plan.tmcSpis.flatMap(b=>b.devices.map(({plan:d})=>[d.model+' '+d.stepper,d] as const))]);
 for(const driver of printer.hardware.drivers){const plan=drivers.get(driver.section);if(!plan)throw new Error('TMC status configuration owner missing');readers.set(driver.section,tmc220xStatusReader(plan,driver.monitor,()=>driver.current.current,()=>{const sample=driver.phase.sample;if(!sample)return null;const stepper=printer.hardware.plan.steppers.find(s=>s.section===driver.section.slice(driver.section.indexOf(' ')+1))!;return {offset:sample.offset,position:printer.machine.port.phaseOffsetPosition(stepper.emitter,sample.offset)};}));}
 for(const sensor of printer.hardware.combinedSensors){readers.set(sensor.section,()=>sensor.state.objectStatus);readers.set('temperature_combined '+sensor.section.trim().split(/\s+/).at(-1),()=>({temperature:sensor.state.objectStatus.temperature}));}
 for(const sensor of printer.hardware.hostSensors){readers.set(sensor.section,()=>sensor.state.objectStatus);readers.set('temperature_host '+sensor.section.trim().split(/\s+/).at(-1),()=>({temperature:sensor.state.objectStatus.temperature}));}
 for(const sensor of printer.hardware.sensors)readers.set(sensor.section,()=>sensor.state.objectStatus);
 for(const pin of printer.hardware.outputPins)readers.set(pin.settings.section,()=>({value:pin.runtime.status.value}));
 for(const fan of printer.hardware.fans)readers.set(fan.section,()=>({speed:fan.runtime.status.speed,rpm:null}));
 for(const fan of printer.hardware.temperatureFans)readers.set(fan.section,()=>({temperature:fan.state.objectStatus.temperature,target:fan.control.settings.target,speed:printer.hardware.fans.find(f=>f.section===fan.section)!.runtime.status.speed,rpm:null}));
 for(const sensor of printer.filamentSensors)readers.set(sensor.section,()=>({...sensor.runtime.status}));
 return new NativeObjects(readers,serialClock.now);
}
