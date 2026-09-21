import {assertSerialAvailable} from './serial-ownership.ts';
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import {readUsbFirmware} from './flash-usb-cli.ts';
import {findFirmwareIdentity,flashKatapultFirmware} from './firmware-identity.ts';
import {openKatapultSerial} from './katapult-serial.ts';
import {prepareKatapultSerial} from './katapult-serial-startup.ts';
import {openKatapultCAN,katapultCanAddress} from './katapult-can.ts';
import {flashKatapultTarget,requestKatapultTarget} from './katapult-startup.ts';
import {katapultStatus} from './katapult-status.ts';
import {openCanDiscovery,queryCanDevices} from './can-query.ts';
const help='Usage: node scripts/katapult.ts [-i can0 -u UUID | -d SERIAL] [-f FIRMWARE]\nModes: -s/--status, -r/--request-bootloader, -q/--query (CAN only)\nOptions: -b/--baud 250000, --node-id 129, --already-bootloader, --prime, --expected-mcu MCU, -v/--verbose\nQuery does not clear assigned node IDs. CAN flash requests targeted reboot unless --already-bootloader; USB Klipper ports request boot entry.\n';
const expanded=(path:string)=>resolve(path.startsWith('~/')?homedir()+path.slice(1):path);
export function parseKatapultArgs(argv:string[]){
 const {values:v}=parseArgs({args:argv,options:{device:{type:'string',short:'d'},baud:{type:'string',short:'b'},interface:{type:'string',short:'i'},firmware:{type:'string',short:'f'},uuid:{type:'string',short:'u'},query:{type:'boolean',short:'q'},status:{type:'boolean',short:'s'},'request-bootloader':{type:'boolean',short:'r'},verbose:{type:'boolean',short:'v'},help:{type:'boolean',short:'h'},'already-bootloader':{type:'boolean'},prime:{type:'boolean'},'node-id':{type:'string'},'expected-mcu':{type:'string'}}});
 if(v.help)return {help:true as const};
 const mode=v.query?'query':v.status?'status':v['request-bootloader']?'request':'flash';
 if([v.query,v.status,v['request-bootloader']].filter(Boolean).length>1)throw new Error('Choose one Katapult mode');
 const baud=Number(v.baud??250000),nodeId=Number(v['node-id']??129),name=v.interface??'can0';
 if(!/^\d+$/.test(v.baud??'250000')||!Number.isInteger(baud)||baud<1||baud>4000000||!/^\d+$/.test(v['node-id']??'129')||!Number.isInteger(nodeId)||nodeId<0||nodeId>255||!/^[A-Za-z0-9_.:-]{1,15}$/.test(name))throw new Error('Invalid baud, node ID or interface');
 if(v.device!==undefined&&(!v.device||v.device.includes('\0')||v.uuid!==undefined||v.interface!==undefined||v['node-id']!==undefined||mode==='query'))throw new Error('Conflicting serial/CAN options');
 if(v.device===undefined&&(v.baud!==undefined||v.prime))throw new Error('Baud and priming require a serial device');
 if(mode!=='flash'&&(v.firmware!==undefined||v['expected-mcu']!==undefined||v['already-bootloader']))throw new Error('Firmware, expected MCU and already-bootloader apply only to flashing');
 if(mode==='query'&&v.uuid!==undefined)throw new Error('Query does not select a UUID');
 if(v['expected-mcu']!==undefined&&!v['expected-mcu'])throw new Error('Expected MCU must not be empty');
 const uuid=v.device===undefined&&mode!=='query'?katapultCanAddress(v.uuid??'',nodeId).uuid:undefined;
 const firmware=expanded(v.firmware??'~/klipper/out/klipper.bin');if(firmware.includes('\0'))throw new Error('Invalid firmware path');
 return {help:false as const,mode,device:v.device===undefined?undefined:expanded(v.device),name,uuid,firmware,baud,nodeId,prime:v.prime??false,alreadyBootloader:v['already-bootloader']??false,expectedMcu:v['expected-mcu'],verbose:v.verbose??false};
}
export async function runKatapult(argv:string[],signal:AbortSignal,output:(text:string)=>void){
 const o=parseKatapultArgs(argv);if(o.help){output(help);return;}signal.throwIfAborted();
 if(o.mode==='query'){const found=await queryCanDevices(openCanDiscovery(o.name),signal);for(const d of found)output(`Detected UUID: ${d.uuid}, Application: ${d.application==='CanBoot'?'Katapult':d.application}\n`);output('CANBus UUID Query Complete\n');return;}
 if(o.device!==undefined){
  const firmware=o.mode==='flash'?await readUsbFirmware(o.firmware,signal):undefined;
  if(firmware){const identity=await findFirmwareIdentity(firmware,signal);if(o.expectedMcu!==undefined&&identity?.mcu!==undefined&&o.expectedMcu!==identity.mcu)throw new Error('Requested MCU does not match firmware dictionary');}
  const selected=await prepareKatapultSerial(o.device,o.baud,signal,{requestOnly:o.mode==='request',alreadyBootloader:o.alreadyBootloader,prime:o.prime});
  if(o.mode==='request'){output('Bootloader Request Complete\n');return;}
  if(selected.device!==o.device)await assertSerialAvailable(selected.device,signal);
  const transport=openKatapultSerial(selected.device,{baud:o.baud,prime:selected.prime},signal);let result;
  try{result=firmware?await flashKatapultFirmware(firmware,transport,signal,{expectedMcu:o.expectedMcu}):await katapultStatus(transport,signal);}finally{transport.close();}
  if(o.verbose||o.mode==='status')output(JSON.stringify(result)+'\n');output(o.mode==='status'?'Status Request Complete\n':'Programming Complete\n');return;
 }
 if(o.mode==='request'){const result=await requestKatapultTarget(o.name,o.uuid!,signal);if(o.verbose)output(JSON.stringify(result)+'\n');output('Bootloader Request Complete\n');return;}
 if(o.mode==='status'){const transport=await openKatapultCAN(o.name,o.uuid!,{nodeId:o.nodeId},signal);let status;try{status=await katapultStatus(transport,signal,o.uuid);}finally{transport.close();}output(JSON.stringify(status)+'\nStatus Request Complete\n');return;}
 const firmware=await readUsbFirmware(o.firmware,signal),result=await flashKatapultTarget(o.name,o.uuid!,firmware,signal,{nodeId:o.nodeId,expectedMcu:o.expectedMcu,alreadyBootloader:o.alreadyBootloader});if(o.verbose)output(JSON.stringify(result)+'\n');output('Programming Complete\n');
}
