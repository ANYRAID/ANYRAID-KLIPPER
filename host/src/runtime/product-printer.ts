import {connectConfiguredPrinter,type ConfiguredPrinterOptions} from './configured-printer.ts';
import {connectProductMotionPrinter,type ProductPrinterOptions} from './product-motion-printer.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {MCUConnection} from './mcu-group.ts';
import type {HardwareLayout} from '../config/hardware.ts';
export type {ProductPrinterOptions} from './product-motion-printer.ts';
export function connectProductPrinter(reader:ConfigurationReader,connections:readonly MCUConnection[],primaryId:string,layout:HardwareLayout,options:ConfiguredPrinterOptions,product:ProductPrinterOptions,signal:AbortSignal){
 return connectProductMotionPrinter(reader,layout,product,signal,async()=>{
  const printer=await connectConfiguredPrinter(reader,connections,primaryId,layout,options,signal);
  return Object.freeze({...printer,machine:printer.linear});
 });
}
