import {NativeObjects,type NativeObjectReader} from '../moonraker/native-objects.ts';
import {readNativeHostStatus,type NativeHostStatusSource} from '../moonraker/native-host-status.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {connectProductPrinter} from './product-printer.ts';
/** Publish only fields backed by the assembled native owners. Missing fields
 * retain the query protocol's null behavior; no synthetic print durations. */
export function productObjects(printer:Awaited<ReturnType<typeof connectProductPrinter>>,nativeHost:NativeHostStatusSource):NativeObjects{
 const readers=new Map<string,NativeObjectReader>([
  ['native_host',()=>readNativeHostStatus(nativeHost)],
  ['gcode_move',()=>printer.print.gcode.coordinates.objectStatus],
  ['virtual_sdcard',()=>printer.print.file.objectStatus],
  ['toolhead',()=>{const k=printer.linear.kinematics.status,l=printer.linear.limits;return {homed_axes:k.homedAxes,axis_minimum:[...k.axisMinimum,0],axis_maximum:[...k.axisMaximum,0],position:[...printer.linear.port.position()],extruder:'extruder',max_velocity:l.maxVelocity,max_accel:l.maxAccel};}],
  ['heaters',()=>{const h=printer.hardware.heaters.status;return {available_heaters:h.available_heaters,available_sensors:h.available_sensors,available_monitors:[]};}],
 ]);
 for(const [i,heater] of printer.hardware.plan.heaters.entries())readers.set(heater.section,()=>printer.hardware.analog[i].runtime.objectStatus);
 for(const fan of printer.hardware.fans)readers.set(fan.section,()=>({speed:fan.runtime.status.speed,rpm:null}));
 return new NativeObjects(readers,serialClock.now);
}
