import {access,readdir,realpath} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {connectUART,type UARTOptions} from '../protocol/uart.ts';
import {assertSerialAvailable} from './serial-ownership.ts';
import type {SDFlashConnection} from './sd-flash.ts';
/** Prefer USB topology identity, which survives firmware serial-number changes. */
export async function sdFlashDevicePath(device:string,signal:AbortSignal,byPath='/dev/serial/by-path'){
 signal.throwIfAborted();if(!isAbsolute(device)||device.includes('\0')||!isAbsolute(byPath)||byPath.includes('\0'))throw new Error('SD flash requires an absolute device path');const target=await realpath(device);signal.throwIfAborted();
 let names:string[];try{names=(await readdir(byPath)).sort();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return device;}
 for(const name of names){signal.throwIfAborted();const path=join(byPath,name);try{if(await realpath(path)===target)return path;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
 signal.throwIfAborted();return device;
}
export interface SDReconnectClock {now():number;sleep(ms:number,signal:AbortSignal):Promise<void>;exists(path:string):Promise<boolean>;}
const clock:SDReconnectClock={now:()=>performance.now(),sleep:async(ms,signal)=>{await delay(ms,undefined,{signal});},exists:async path=>{try{await access(path);return true;}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}}};
/** Wait even if the UART node never disappears. Presence alone is not a reboot
 * proof: connectUART still downloads a new dictionary and synchronizes clocks. */
export async function waitSDReconnect(path:string,signal:AbortSignal,timing:SDReconnectClock=clock){
 signal.throwIfAborted();const deadline=timing.now()+60000;await timing.sleep(3000,signal);let presentSince:number|undefined;
 while(true){signal.throwIfAborted();if(timing.now()>=deadline)throw new Error('SD flash device did not reconnect within 60 seconds');if(await timing.exists(path)){presentSince??=timing.now();if(timing.now()-presentSince>=250){signal.throwIfAborted();return;}}else presentSince=undefined;await timing.sleep(250,signal);}
}
/** Offline maintenance only. Caller supplies the independent safety/stop policy;
 * this adapter never stops services or pretends that closing UART stops motors. */
export function sdFlashUART(device:string,options:UARTOptions):SDFlashConnection{
 if(!isAbsolute(device)||device.includes('\0')||!Number.isInteger(options.baud)||options.baud<1||options.baud>0xffffffff||typeof options.stopDevice!=='function')throw new Error('Invalid SD flash UART options');
 const settings={...options};let busy=false;
 return {async connect(signal,reconnect){
  signal.throwIfAborted();if(busy)throw new Error('SD flash UART connection already opening');busy=true;
  try{if(reconnect)await waitSDReconnect(device,signal);await assertSerialAvailable(device,signal);signal.throwIfAborted();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(new Error('SD flash UART initialization timed out')),60000);const bounded=AbortSignal.any([signal,controller.signal]);
   try{return await connectUART(device,settings,bounded);}finally{clearTimeout(timer);}
  }finally{busy=false;}
 }};
}
