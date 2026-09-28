import {connectConfiguredDeltaPrinter,type ConfiguredDeltaPrinterOptions} from './configured-delta-printer.ts';
import {connectProductMotionPrinter,type ProductPrinterOptions} from './product-motion-printer.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUConnection} from './mcu-group.ts';
import type {HardwareLayout} from '../config/hardware.ts';
export function connectDeltaProductPrinter(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,options:ConfiguredDeltaPrinterOptions,product:ProductPrinterOptions,signal:AbortSignal){
 return connectProductMotionPrinter(reader,layout,product,signal,async()=>{
  const printer=await connectConfiguredDeltaPrinter(reader,connections,primaryId,layout,options,signal);
  return Object.freeze({...printer,machine:printer.delta});
 });
}
