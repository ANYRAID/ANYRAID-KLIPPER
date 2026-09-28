import {bindTmcCurrent} from '../gcode/tmc-current.ts';
import {startConfiguredHardware,type HardwareStartupOptions} from './configured-hardware.ts';
import {initializeConfiguredMotion,type InitialMotionOptions,type ConfiguredPrintOptions} from './initial-motion.ts';
import type {createNativeLinearPrint} from '../operations/native-linear-print.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUGroup} from './mcu-group.ts';
export interface ConfiguredMotionPrinterOptions {hardware:HardwareStartupOptions;motion:InitialMotionOptions;print:ConfiguredPrintOptions;}
export interface ConfiguredPrintPort {createPrint(options:ConfiguredPrintOptions):ReturnType<typeof createNativeLinearPrint>;}
/** Shared transaction after machine-specific preflight. The initialized owner
 * retains every replacement motion generation and joins print shutdown. */
export async function startConfiguredMotionPrinter<T extends ConfiguredPrintPort>(reader:ConfigurationReader,group:MCUGroup,clocks:ReadonlyMap<string,FanClock>,layout:HardwareLayout,options:ConfiguredMotionPrinterOptions,signal:AbortSignal,createPort:(initial:Awaited<ReturnType<typeof initializeConfiguredMotion>>)=>T){
 signal.throwIfAborted();group.assertActive();
 if(!options.hardware.motion?.length)throw new Error('Configured printer requires motion descriptors');
 const settings=snapshotMotionPrinterOptions(options);
 let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const cancelled=()=>{void hardware?.close(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancelled,{once:true});
 const active=()=>{signal.throwIfAborted();group.assertActive();if(hardware&&hardware.status.state!=='ready')throw new Error('Configured printer stopped during startup');};
 try{
  hardware=await startConfiguredHardware(reader,group,clocks,layout,settings.hardware,signal);active();
  const initial=await initializeConfiguredMotion(hardware,settings.motion,signal);active();
  const motion=createPort(initial);active();
  const print=await motion.createPrint(settings.print);active();bindTmcCurrent(print.gcode.dispatch,hardware.drivers);
  return Object.freeze({hardware,initial,motion,print,close:hardware.close});
 }catch(error){try{await hardware?.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Configured printer startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',cancelled);}
}
export function snapshotMotionPrinterOptions(options:ConfiguredMotionPrinterOptions):ConfiguredMotionPrinterOptions{return {hardware:{...options.hardware,motion:structuredClone(options.hardware.motion),heaterGcodeIds:{...options.hardware.heaterGcodeIds}},motion:structuredClone(options.motion),print:{...options.print,parking:{...options.print.parking,parkXY:[...options.print.parking.parkXY]},startupHoming:{...options.print.startupHoming,axes:[...options.print.startupHoming.axes]},lifecycle:{...options.print.lifecycle}}};}
