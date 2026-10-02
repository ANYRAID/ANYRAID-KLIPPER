import {assertSerialAvailable} from './serial-ownership.ts';
import {readFile,realpath,stat} from 'node:fs/promises';
import {closeSync,writeSync} from 'node:fs';
import {basename,dirname,join} from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {enterUsbBootloader} from './usb-bootloader.ts';
import {waitKatapultBridge} from './katapult-bridge.ts';
import {katapultNeedsPriming} from './katapult-serial.ts';
async function optional(path:string,signal:AbortSignal){signal.throwIfAborted();try{return (await readFile(path,{encoding:'utf8',signal})).trim().toLowerCase();}catch(error){signal.throwIfAborted();if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return '';throw error;}}
async function usbPath(device:string,signal:AbortSignal){
 signal.throwIfAborted();let path:string;try{path=await realpath(join('/sys/class/tty',basename(await realpath(device))));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 while(path!=='/'){signal.throwIfAborted();try{await stat(join(path,'busnum'));await stat(join(path,'devnum'));return path;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}path=dirname(path);}
}
/** Original serial boot request bytes, once, with bounded nonblocking writes. */
export async function requestKatapultSerialBootloader(device:string,baud:number,signal:AbortSignal){
 signal.throwIfAborted();const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as {openUART(path:string,baud:number,rts:boolean):number},fd=native.openUART(device,baud,true);
 try{const bytes=Buffer.from('~ \x1c Request Serial Bootloader!! ~'),deadline=performance.now()+2000;let offset=0;while(offset<bytes.length){signal.throwIfAborted();if(performance.now()>=deadline)throw new Error('Serial bootloader request timed out');let count=0;try{count=writeSync(fd,bytes,offset);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}offset+=count;if(!count)await delay(1,undefined,{signal});}await delay(1000,undefined,{signal});}catch(error){throw signal.aborted?signal.reason:error;}finally{closeSync(fd);}
}
export async function prepareKatapultSerial(device:string,baud:number,signal:AbortSignal,options:{requestOnly?:boolean;alreadyBootloader?:boolean;prime?:boolean}={}){
 signal.throwIfAborted();options={...options};await assertSerialAvailable(device,signal);const usb=await usbPath(device,signal);let selected=device,prime=options.prime??false;
 if(usb){const id=(await optional(join(usb,'idVendor'),signal))+':'+(await optional(join(usb,'idProduct'),signal)),manufacturer=await optional(join(usb,'manufacturer'),signal);
  if(!options.alreadyBootloader&&(id==='1d50:614e'||manufacturer==='klipper')){await enterUsbBootloader(device,signal);selected=await waitKatapultBridge({path:usb,serial:'',uuid:''},signal);prime ||=katapultNeedsPriming(await optional(join(usb,'product'),signal));return {device:selected,prime};}
  if(id==='1d50:6177'||manufacturer==='katapult'){prime ||=katapultNeedsPriming(await optional(join(usb,'product'),signal));return {device:selected,prime};}
 }
 if(options.requestOnly)await requestKatapultSerialBootloader(device,baud,signal);
 return {device:selected,prime};
}
