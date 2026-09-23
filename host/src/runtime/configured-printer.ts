import {captureGroupPrintClocks} from '../timing/group-print-clocks.ts';
import {startConfiguredHardware,type HardwareStartupOptions} from './configured-hardware.ts';
import {initializeConfiguredMotion,type InitialMotionOptions,type ConfiguredPrintOptions} from './initial-motion.ts';
import {readLinearMotionConfiguration} from '../config/linear-motion.ts';
import type {ConfiguredLinearHoming} from '../config/linear-homing.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {MCUGroup,type MCUConnection} from './mcu-group.ts';
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
 const settings=snapshotOptions(options);
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

/** Capture actual connected clocks instead of requiring caller-built mappings. */
export function startClockedPrinter(reader:ConfigurationReader,group:MCUGroup,primaryId:string,layout:HardwareLayout,options:ConfiguredPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();
 return startConfiguredPrinter(reader,group,captureGroupPrintClocks(group,primaryId),layout,options,signal);
}

function snapshotOptions(options:ConfiguredPrinterOptions):ConfiguredPrinterOptions{return {hardware:{...options.hardware,motion:structuredClone(options.hardware.motion),heaterGcodeIds:{...options.hardware.heaterGcodeIds}},motion:structuredClone(options.motion),linear:structuredClone(options.linear),print:{...options.print,parking:{...options.print.parking,parkXY:[...options.print.parking.parkXY]},startupHoming:{...options.print.startupHoming,axes:[...options.print.startupHoming.axes]},lifecycle:{...options.print.lifecycle}}};}

/** Own connectors from acquisition through print shutdown. Connections must meet
 * MCUConnection's cancellation and independent safety contract (e.g. uartMCU).
 * This is single-use; a disconnect never reconnects or replays motion. */
export async function connectConfiguredPrinter(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,options:ConfiguredPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();
 if(!connections.some(c=>c.id===primaryId))throw new Error('Primary MCU is not declared');
 if(!options.hardware.motion?.length)throw new Error('Configured printer requires motion descriptors');
 readLinearMotionConfiguration(reader);
 const settings=snapshotOptions(options),savedLayout=structuredClone(layout),group=new MCUGroup(connections);
 let printer:Awaited<ReturnType<typeof startClockedPrinter>>|undefined;
 try{
  await group.start(signal);signal.throwIfAborted();
  printer=await startClockedPrinter(reader,group,primaryId,savedLayout,settings,signal);
  signal.throwIfAborted();group.assertActive();
  return Object.freeze({...printer,group});
 }catch(error){
  const results=await Promise.allSettled([group.stop(error),printer?.close(error)]),errors=results.filter(r=>r.status==='rejected').map(r=>r.reason).filter(e=>e!==error);
  if(errors.length)throw new AggregateError([error,...errors],'Printer connection and cleanup failed',{cause:error});throw error;
 }
}
