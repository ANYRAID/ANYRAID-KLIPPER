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
  ['toolhead',()=>{const k=printer.linear.kinematics.status;return {homed_axes:k.homedAxes,axis_minimum:[...k.axisMinimum,0],axis_maximum:[...k.axisMaximum,0],position:[...printer.linear.port.homingPosition()],extruder:pressure?.name??'extruder',...printer.linear.port.velocityStatus};}],
  ['heaters',()=>{const h=printer.hardware.heaters.status;return {available_heaters:h.available_heaters,available_sensors:h.available_sensors,available_monitors:[]};}],
 ]);
 const retraction=printer.print.gcode.retraction;if(retraction)readers.set('firmware_retraction',()=>({...retraction.status}));
 for(const [i,heater] of printer.hardware.plan.heaters.entries())readers.set(heater.section,()=>{
  const thermal=printer.hardware.analog[i].runtime.objectStatus;
  if(pressure?.name!==heater.section)return thermal;
  const accepted=pressure.pressureAdvance;
  return {...thermal,pressure_advance:accepted.advance,smooth_time:accepted.smoothTime};
 });
 for(const fan of printer.hardware.fans)readers.set(fan.section,()=>({speed:fan.runtime.status.speed,rpm:null}));
 return new NativeObjects(readers,serialClock.now);
}
