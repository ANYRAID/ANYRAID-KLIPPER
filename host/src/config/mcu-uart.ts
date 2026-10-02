import {readMCUConnections} from './mcu-connections.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface MCUUARTConfiguration {readonly id:string;readonly section:string;readonly path:string;readonly baud:number;}
/** Compatibility entry for deployments explicitly restricted to UART. */
export function readMCUUARTConfiguration(reader:ConfigurationReader):readonly MCUUARTConfiguration[]{
 return Object.freeze(readMCUConnections(reader).map(plan=>{
  if(plan.transport!=='uart')throw new Error('Non-UART MCU requires its dedicated connection provider');
  return Object.freeze({id:plan.id,section:plan.section,path:plan.path,baud:plan.baud});
 }));
}
