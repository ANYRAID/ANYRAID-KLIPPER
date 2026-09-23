import {startConfiguredHardware,type HardwareStartupOptions} from './configured-hardware.ts';
import {initializeConfiguredMotion,type InitialMotionOptions,type ConfiguredPrintOptions} from './initial-motion.ts';
import {readLinearMotionConfiguration} from '../config/linear-motion.ts';
import type {ConfiguredLinearHoming} from '../config/linear-homing.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUGroup} from './mcu-group.ts';
export interface ConfiguredPrinterOptions {
 hardware:HardwareStartupOptions;
 motion:InitialMotionOptions;
 linear:ConfiguredLinearHoming;
 print:ConfiguredPrintOptions;
}
/** Own configuration through print assembly on an already connected MCU group.
 * Completion grants no homing or heating permission. Startup cancellation spans
 * all stages; close owns the lifetime after successful return. */
export async function startConfiguredPrinter(reader:ConfigurationReader,group:MCUGroup,clocks:ReadonlyMap<string,FanClock>,layout:HardwareLayout,options:ConfiguredPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();group.assertActive();
 if(!options.hardware.motion?.length)throw new Error('Configured printer requires motion descriptors');
 readLinearMotionConfiguration(reader);
 const settings:ConfiguredPrinterOptions={hardware:{...options.hardware,motion:structuredClone(options.hardware.motion),heaterGcodeIds:{...options.hardware.heaterGcodeIds}},motion:structuredClone(options.motion),linear:structuredClone(options.linear),print:{...options.print,parking:{...options.print.parking,parkXY:[...options.print.parking.parkXY]},startupHoming:{...options.print.startupHoming,axes:[...options.print.startupHoming.axes]},lifecycle:{...options.print.lifecycle}}};
 let hardware:Awaited<ReturnType<typeof startConfiguredHardware>>|undefined;
 const cancelled=()=>{void hardware?.close(signal.reason).catch(()=>{});};signal.addEventListener('abort',cancelled,{once:true});
 const active=()=>{signal.throwIfAborted();group.assertActive();if(hardware&&hardware.status.state!=='ready')throw new Error('Configured printer stopped during startup');};
 try{
  hardware=await startConfiguredHardware(reader,group,clocks,layout,settings.hardware,signal);active();
  const initial=await initializeConfiguredMotion(hardware,settings.motion,signal);active();
  const linear=initial.createLinearPort(reader,settings.linear);active();
  const print=await linear.createPrint(settings.print);active();
  return Object.freeze({hardware,initial,linear,print,close:hardware.close});
 }catch(error){try{await hardware?.close(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Configured printer startup and cleanup failed',{cause:error});}throw error;}
 finally{signal.removeEventListener('abort',cancelled);}
}
