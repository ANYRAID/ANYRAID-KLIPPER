import {closeSync,readSync,writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {SerialSession,type SerialSessionOptions} from './serial-session.ts';
interface Native {openUART(path:string,baud:number,rts:boolean):number;setUARTBaud(fd:number,baud:number):void}
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
export interface UARTOptions extends SerialSessionOptions {
 baud:number;rts?:boolean;
 /** Defaults to the original Klipper AVR leave sequence. Disable only for a
  * device whose startup contract does not use that sequence. */
 leaveBootloader?:boolean;
}
function discard(fd:number,limit:number){const bytes=Buffer.allocUnsafe(limit);try{readSync(fd,bytes);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}}
/** Opens a Linux UART exclusively, prepares the bootloader, then transfers fd
 * ownership to SerialSession's native duplicate. No automatic reconnect/replay. */
export async function connectUART(path:string,options:UARTOptions,signal:AbortSignal):Promise<SerialSession>{
 signal.throwIfAborted();
 options={...options};
 if(typeof options.stopDevice!=='function'||options.leaveBootloader!==undefined&&typeof options.leaveBootloader!=='boolean')throw new TypeError('Invalid UART options');
 let fd=native.openUART(path,options.baud,options.rts??true),session:SerialSession|undefined;
 try{
  if(options.leaveBootloader!==false){
   native.setUARTBaud(fd,2400);discard(fd,1);native.setUARTBaud(fd,115200);
   await delay(100,undefined,{signal});discard(fd,4096);
   const bytes=Buffer.from([0x1b,1,0,1,0x0e,0x11,4]);let offset=0;const deadline=performance.now()+1000;
   while(offset<bytes.length){signal.throwIfAborted();if(performance.now()>=deadline)throw new Error('UART bootloader write timed out');try{offset+=writeSync(fd,bytes,offset);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}if(offset<bytes.length)await delay(1,undefined,{signal});}
   await delay(50,undefined,{signal});discard(fd,4096);native.setUARTBaud(fd,options.baud);
  }
  signal.throwIfAborted();session=new SerialSession(fd,options);const owned=fd;fd=-1;closeSync(owned);
  await session.initialize(signal);return session;
 }catch(error){if(session)try{await session.stop(error);}catch{/* retained in session status */}throw error;}
 finally{if(fd>=0)closeSync(fd);}
}
