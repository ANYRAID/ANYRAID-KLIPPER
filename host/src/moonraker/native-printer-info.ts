import {hostname,cpus} from 'node:os';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {readNativeHostStatus} from './native-host-status.ts';
export function nativePrinterState(status:ReturnType<typeof readNativeHostStatus>){
 if(status.closing||status.admission_closed||['failed','stopping','stopped'].includes(status.group_state)||['failed','stopping','stopped'].includes(status.hardware_state)||status.print_state==='failed'||status.mcus.some(m=>['closed','unavailable'].includes(m.state)))return {state:'shutdown',state_message:'Native printer requires device reinitialization'};
 if(status.print_state==='interrupted')return {state:'error',state_message:'Interrupted print requires explicit recovery'};
 if(status.ready)return {state:'ready',state_message:'Native printer is ready'};
 return {state:'startup',state_message:'Native printer is initializing'};
}
export interface NativePrinterIdentity {configFile:string;softwareVersion:string;}
/** Immutable process identity plus live owner state. Empty legacy Python/log
 * fields mean no Python interpreter or dedicated Klippy log is configured. */
export class NativePrinterInformation {
 readonly #identity;
 constructor(identity:NativePrinterIdentity){
  if(!isAbsolute(identity.configFile)||identity.configFile.includes('\0')||identity.configFile.length>4096||typeof identity.softwareVersion!=='string'||!identity.softwareVersion||identity.softwareVersion.length>1024)throw new Error('Invalid native printer identity');
  const cpu=cpus();this.#identity=Object.freeze({hostname:hostname(),klipper_path:fileURLToPath(new URL('../../../',import.meta.url)),python_path:'',node_path:process.execPath,host_type:'node',process_id:process.pid,user_id:process.getuid?.()??0,group_id:process.getgid?.()??0,log_file:'',config_file:identity.configFile,software_version:identity.softwareVersion,cpu_info:cpu.length+' core '+(cpu[0]?.model??process.arch)});
 }
 read(status:ReturnType<typeof readNativeHostStatus>){return {...this.#identity,...nativePrinterState(status)};}
}
