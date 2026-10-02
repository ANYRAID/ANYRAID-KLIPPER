import {isAbsolute,normalize} from 'node:path';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
type Identity={readonly id:string;readonly section:string};
export type MCUConnectionConfiguration=Identity&({readonly transport:'uart';readonly path:string;readonly baud:number}|{readonly transport:'pipe';readonly path:string}|{readonly transport:'can';readonly interface:string;readonly uuid:string});
/** Compile transport declarations without device I/O. */
export function readMCUConnections(reader:ConfigurationReader):readonly MCUConnectionConfiguration[]{
 const sections=reader.sections().filter(s=>s==='mcu'||s.startsWith('mcu '));
 if(!sections.includes('mcu')||sections.length>16)throw new Error('Connection configuration requires primary mcu and at most 16 MCUs');
 const ids=new Set<string>(),addresses=new Set<string>();
 return Object.freeze(sections.map((section):MCUConnectionConfiguration=>{
  const id=section==='mcu'?'mcu':section.slice(4),config=reader.section(section);
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(id)||ids.has(id))throw new Error('Invalid or duplicate MCU identity');ids.add(id);
  const claim=(address:string)=>{if(addresses.has(address))throw new Error('Duplicate MCU transport address');addresses.add(address);};
  if(config.hasOption('canbus_uuid')){
   if(config.hasOption('serial')||config.hasOption('baud'))throw new Error('Ambiguous CAN and serial configuration');
   const raw=config.get('canbus_uuid'),iface=config.get('canbus_interface',{defaultValue:'can0'});
   if(!/^(?:0x)?[0-9a-f]{1,12}$/i.test(raw)||!/^[A-Za-z0-9_.:-]{1,15}$/.test(iface))throw new Error('Invalid CAN UUID or interface');
   const uuid=raw.replace(/^0x/i,'').toLowerCase().padStart(12,'0');claim(`can:${iface}:${uuid}`);
   return Object.freeze({id,section,transport:'can',interface:iface,uuid});
  }
  if(config.hasOption('canbus_interface'))throw new Error('CAN interface requires a UUID');
  const raw=config.get('serial');if(!isAbsolute(raw)||raw.includes('\0'))throw new Error('MCU serial path must be absolute');
  const path=normalize(raw);claim(`serial:${path}`);
  if(path.startsWith('/dev/rpmsg_')||path.startsWith('/tmp/klipper_host_')){
   if(config.hasOption('baud'))throw new Error('Character-device transport does not accept UART baud');
   return Object.freeze({id,section,transport:'pipe',path});
  }
  return Object.freeze({id,section,transport:'uart',path,baud:config.getInt('baud',{defaultValue:250000,minval:2400,maxval:4000000})});
 }));
}
