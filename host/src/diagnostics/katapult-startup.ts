import {readFile} from 'node:fs/promises';
import {join,isAbsolute} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {findFirmwareIdentity,flashKatapultFirmware} from './firmware-identity.ts';
import {findKatapultBridge,waitKatapultBridge,type UsbBridgeRoots} from './katapult-bridge.ts';
import {katapultCanAddress,requestKatapultCANBootloader,flashKatapultCAN} from './katapult-can.ts';
import {openKatapultSerial,katapultNeedsPriming} from './katapult-serial.ts';
export interface KatapultStartupOptions {nodeId?:number;expectedMcu?:string;alreadyBootloader?:boolean;roots?:UsbBridgeRoots;}
/** Snapshot/preflight before reboot. A detected USB-CAN bridge transitions to
 * serial only; failure never falls back to a second CAN programming attempt. */
export async function flashKatapultTarget(name:string,uuid:string,image:Uint8Array,signal:AbortSignal,options:KatapultStartupOptions={}){
 signal.throwIfAborted();options={...options,roots:{...options.roots}};const identity=katapultCanAddress(uuid,options.nodeId);
 if(!/^[A-Za-z0-9_.:-]{1,15}$/.test(name)||!image.length||image.length>64*1024*1024||options.alreadyBootloader!==undefined&&typeof options.alreadyBootloader!=='boolean'||options.expectedMcu!==undefined&&(typeof options.expectedMcu!=='string'||!options.expectedMcu))throw new TypeError('Invalid Katapult startup options');
 for(const path of [options.roots?.usb,options.roots?.dev])if(path!==undefined&&(typeof path!=='string'||!isAbsolute(path)||path.includes('\0')))throw new TypeError('Invalid USB bridge root');
 const snapshot=Buffer.from(image),firmware=await findFirmwareIdentity(snapshot,signal);
 if(options.expectedMcu!==undefined&&firmware?.mcu!==undefined&&firmware.mcu!==options.expectedMcu)throw new Error('Requested MCU does not match firmware dictionary');
 if(options.alreadyBootloader)return {transport:'can' as const,...await flashKatapultCAN(name,identity.uuid,snapshot,signal,options)};
 const bridge=await findKatapultBridge(name,identity.uuid,signal,options.roots);
 await requestKatapultCANBootloader(name,identity.uuid,signal);
 if(!bridge){await delay(1000,undefined,{signal});return {transport:'can' as const,...await flashKatapultCAN(name,identity.uuid,snapshot,signal,options)};}
 const device=await waitKatapultBridge(bridge,signal,options.roots);
 let product='';try{product=(await readFile(join(bridge.path,'product'),{encoding:'utf8',signal})).trim().toLowerCase();}catch(error){signal.throwIfAborted();if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 const serial=openKatapultSerial(device,{prime:katapultNeedsPriming(product)},signal);
 try{return {transport:'serial' as const,...await flashKatapultFirmware(snapshot,serial,signal,{expectedMcu:options.expectedMcu})};}finally{serial.close();}
}
/** Request only; ordinary CAN completion means the request was sent, not that a
 * later CONNECT has succeeded. USB bridge completion includes re-enumeration. */
export async function requestKatapultTarget(name:string,uuid:string,signal:AbortSignal){
 signal.throwIfAborted();const identity=katapultCanAddress(uuid),bridge=await findKatapultBridge(name,identity.uuid,signal);
 await requestKatapultCANBootloader(name,identity.uuid,signal);
 if(bridge)return {transport:'serial' as const,device:await waitKatapultBridge(bridge,signal)};
 await delay(1000,undefined,{signal});return {transport:'can' as const};
}
