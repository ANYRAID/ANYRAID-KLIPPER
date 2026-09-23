import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
import {SerialSession,type SerialSessionOptions} from './serial-session.ts';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as {openPipe(path:string):number};
/** Exclusively locked prepared character-device stream (RPMsg or PTY); no UART bootloader sequence. */
export async function connectPipe(path:string,options:SerialSessionOptions,signal:AbortSignal):Promise<SerialSession>{
 signal.throwIfAborted();options={...options};
 if(!isAbsolute(path)||path.includes('\0')||options.canClientId!==undefined||typeof options.stopDevice!=='function')throw new TypeError('Invalid pipe connection options');
 let fd=-1,session:SerialSession|undefined;
 try{fd=native.openPipe(path);session=new SerialSession(fd,options);const owned=fd;fd=-1;closeSync(owned);await session.initialize(signal);return session;}
 catch(error){if(session)try{await session.stop(error);}catch{/* retained in status */}throw error;}
 finally{if(fd>=0)closeSync(fd);}
}
