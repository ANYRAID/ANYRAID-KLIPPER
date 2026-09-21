import {openSync,closeSync,fstatSync,constants} from 'node:fs';
import {isAbsolute} from 'node:path';
import {SerialSession,type SerialSessionOptions} from './serial-session.ts';
/** Prepared character-device stream (RPMsg or PTY); no UART bootloader sequence. */
export async function connectPipe(path:string,options:SerialSessionOptions,signal:AbortSignal):Promise<SerialSession>{
 signal.throwIfAborted();options={...options};
 if(!isAbsolute(path)||path.includes('\0')||options.canClientId!==undefined||typeof options.stopDevice!=='function')throw new TypeError('Invalid pipe connection options');
 let fd=-1,session:SerialSession|undefined;
 try{fd=openSync(path,constants.O_RDWR|constants.O_NONBLOCK|constants.O_NOCTTY);if(!fstatSync(fd).isCharacterDevice())throw new Error('Pipe transport requires a character device');session=new SerialSession(fd,options);const owned=fd;fd=-1;closeSync(owned);await session.initialize(signal);return session;}
 catch(error){if(session)try{await session.stop(error);}catch{/* retained in status */}throw error;}
 finally{if(fd>=0)closeSync(fd);}
}
