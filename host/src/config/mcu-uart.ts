import {isAbsolute,normalize} from 'node:path';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface MCUUARTConfiguration {readonly id:string;readonly section:string;readonly path:string;readonly baud:number;}
/** Cold-start UART configuration only. Other transports need their own opener;
 * never silently apply UART setup to CAN, RPMsg or a Linux MCU socket. */
export function readMCUUARTConfiguration(reader:ConfigurationReader):readonly MCUUARTConfiguration[]{
 const sections=reader.sections().filter(s=>s==='mcu'||s.startsWith('mcu '));
 if(!sections.includes('mcu')||sections.length>16)throw new Error('UART configuration requires primary mcu and at most 16 MCUs');
 const ids=new Set<string>(),paths=new Set<string>();
 return Object.freeze(sections.map(section=>{
  const id=section==='mcu'?'mcu':section.slice(4);
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||ids.has(id))throw new Error('Invalid or duplicate UART MCU identity');ids.add(id);
  const config=reader.section(section);
  if(config.hasOption('canbus_uuid')||config.hasOption('canbus_interface'))throw new Error('CAN MCU requires a CAN connection provider');
  const raw=config.get('serial');
  if(!isAbsolute(raw)||raw.includes('\0'))throw new Error('MCU serial path must be absolute');
  const path=normalize(raw);
  if(path.startsWith('/dev/rpmsg_')||path.startsWith('/tmp/klipper_host_'))throw new Error('Non-UART MCU requires a dedicated connection provider');
  if(paths.has(path))throw new Error('Duplicate MCU serial path');paths.add(path);
  const baud=config.getInt('baud',{defaultValue:250000,minval:2400,maxval:4000000});
  return Object.freeze({id,section,path,baud});
 }));
}
