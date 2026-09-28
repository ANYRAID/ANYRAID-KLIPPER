import {validateDeltaPrinter,type planDeltaPrinter} from '../config/delta-printer.ts';
import {startConfiguredMotionPrinter,snapshotMotionPrinterOptions,type ConfiguredMotionPrinterOptions} from './configured-motion-printer.ts';
import {captureGroupPrintClocks} from '../timing/group-print-clocks.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {HardwareLayout} from '../config/hardware.ts';
import type {FanClock} from '../config/cooling-fan.ts';
import {MCUGroup,type MCUConnection} from './mcu-group.ts';
export interface ConfiguredDeltaPrinterOptions extends ConfiguredMotionPrinterOptions {delta:ReturnType<typeof planDeltaPrinter>['delta'];}
export async function startConfiguredDeltaPrinter(reader:ConfigurationReader,group:MCUGroup,clocks:ReadonlyMap<string,FanClock>,layout:HardwareLayout,options:ConfiguredDeltaPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();group.assertActive();validateDeltaPrinter(reader);
 const settings={...snapshotMotionPrinterOptions(options),delta:structuredClone(options.delta)};
 const {motion,...result}=await startConfiguredMotionPrinter(reader,group,clocks,layout,settings,signal,initial=>initial.createDeltaPort(reader,settings.delta));
 return Object.freeze({...result,delta:motion});
}
export function startClockedDeltaPrinter(reader:ConfigurationReader,group:MCUGroup,primaryId:string,layout:HardwareLayout,options:ConfiguredDeltaPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();return startConfiguredDeltaPrinter(reader,group,captureGroupPrintClocks(group,primaryId),layout,options,signal);
}
export async function connectConfiguredDeltaPrinter(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,options:ConfiguredDeltaPrinterOptions,signal:AbortSignal){
 signal.throwIfAborted();if(!connections.some(c=>c.id===primaryId))throw new Error('Primary MCU is not declared');
 if(!options.hardware.motion?.length)throw new Error('Configured printer requires motion descriptors');
 validateDeltaPrinter(reader);
 const settings={...snapshotMotionPrinterOptions(options),delta:structuredClone(options.delta)},savedLayout=structuredClone(layout),group=new MCUGroup(connections);
 let printer:Awaited<ReturnType<typeof startClockedDeltaPrinter>>|undefined;
 try{
  await group.start(signal);signal.throwIfAborted();printer=await startClockedDeltaPrinter(reader,group,primaryId,savedLayout,settings,signal);
  signal.throwIfAborted();group.assertActive();return Object.freeze({...printer,group});
 }catch(error){
  const results=await Promise.allSettled([group.stop(error),printer?.close(error)]),errors=results.filter(r=>r.status==='rejected').map(r=>r.reason).filter(e=>e!==error);
  if(errors.length)throw new AggregateError([error,...errors],'Delta connection and cleanup failed',{cause:error});throw error;
 }
}
