import {assertSerialAvailable} from './serial-ownership.ts';
// GPL-3.0-or-later. Linux filesystem/process adapters for USB flash orchestration.
import {enterUsbBootloader} from './usb-bootloader.ts';
import {access,readFile,readdir,readlink,realpath} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {UsbFlashExitError,type UsbFlashIO} from './flash-usb.ts';

export interface UsbFlashSystemOptions {
 repository:string;
 enterBootloader?:UsbFlashIO['enterBootloader'];
 katapult:UsbFlashIO['katapult'];
 /** Alternate roots for isolated filesystem integration tests. */
 serialByPath?:string;ttyClass?:string;
}
/** Await process closure even after cancellation. Never invoke a shell or retry.
 * Cancellation signals the Linux process group and escalates after one second.
 * This cannot undo completed writes or guarantee termination of privileged tools. */
export async function runUsbFlashCommand(command:readonly string[],repository:string,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();
 if(!isAbsolute(repository)||!command.length||command.some(v=>typeof v!=='string'||v.includes('\0'))||!command[0])throw new TypeError('Invalid flash command');
 const argv=[...command];
 await new Promise<void>((resolve,reject)=>{
  const child=spawn(argv[0],argv.slice(1),{cwd:repository,stdio:'inherit',shell:false,detached:true});
  let spawnError:Error|undefined,killError:unknown,abortCompletion:Promise<void>|undefined;
  const kill=(kind:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,kind);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')killError=error;}};
  const abort=()=>{if(abortCompletion)return;kill('SIGTERM');abortCompletion=new Promise(done=>setTimeout(()=>{kill('SIGKILL');done();},1000));};
  child.on('error',error=>{spawnError=error;});
  child.once('close',async(code,killed)=>{
   signal.removeEventListener('abort',abort);await abortCompletion;
   if(killError)reject(new AggregateError([signal.reason,killError],'Unable to cancel flash process group'));
   else if(signal.aborted)reject(signal.reason);
   else if(spawnError)reject(spawnError);
   else if(killed)reject(new Error(`Flash process terminated by ${killed}`));
   else if(code!==0)reject(new UsbFlashExitError(argv[0],code??-1));
   else resolve();
  });
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 });
}
export interface ReconnectClock {now():number;sleep(ms:number,signal:AbortSignal):Promise<void>;exists(path:string):Promise<boolean>;}
const reconnectClock:ReconnectClock={now:()=>performance.now(),sleep:async(ms,signal)=>{await delay(ms,undefined,{signal});},exists:async path=>{try{await access(path);return true;}catch(error){if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}}};
/** Unlike the old timeout fallback, never launch a writer without reconnection.
 * The alternative must remain present for 300 ms; disappearance resets its timer. */
export async function waitUsbPath(path:string,alternative:string|undefined,signal:AbortSignal,clock:ReconnectClock=reconnectClock):Promise<string>{
 signal.throwIfAborted();await clock.sleep(100,signal);const deadline=clock.now()+4000;let alternativeSince:number|undefined;
 while(true){
  await clock.sleep(100,signal);signal.throwIfAborted();
  if(await clock.exists(path)){await clock.sleep(100,signal);signal.throwIfAborted();return path;}
  if(alternative!==undefined&&await clock.exists(alternative)){
   alternativeSince??=clock.now();if(clock.now()-alternativeSince>=300){signal.throwIfAborted();return alternative;}
  }else alternativeSince=undefined;
  signal.throwIfAborted();if(clock.now()>=deadline)throw new Error(`USB device did not reconnect: ${path}`);
 }
}
async function guardedUsbBootloader(device:string,signal:AbortSignal){await assertSerialAvailable(device,signal);await enterUsbBootloader(device,signal);}
export function createUsbFlashSystem(options:UsbFlashSystemOptions):UsbFlashIO {
 const {repository,enterBootloader=guardedUsbBootloader,katapult,serialByPath='/dev/serial/by-path',ttyClass='/sys/class/tty'}=options;
 if(![repository,serialByPath,ttyClass].every(p=>isAbsolute(p)&&!p.includes('\0'))||typeof enterBootloader!=='function'||typeof katapult!=='function')throw new TypeError('Invalid USB system options');
 return {
  async serialPaths(device,signal){signal.throwIfAborted();const tty=await realpath(device),names=await readdir(serialByPath);for(const name of names){signal.throwIfAborted();const path=join(serialByPath,name);try{if(await realpath(path)===tty)return {tty,stable:path};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}signal.throwIfAborted();return {tty,stable:tty};},
  async usbPath(device,signal){signal.throwIfAborted();const tty=join(ttyClass,basename(await realpath(device))),target=await readlink(tty),match=/.*\/usb\d+.*\/(\d+-[0-9.]+):\d+\.\d+\/.*/.exec(target);if(!match)throw new Error('Unable to find tty USB device');const devicePath=await realpath(join(tty,'device'));signal.throwIfAborted();return {busPath:match[1],devicePath};},
  enterBootloader,katapult,waitPath:waitUsbPath,
  async isKatapult(path,signal){signal.throwIfAborted();try{const vendor=await readFile(join(dirname(path),'idVendor'),{encoding:'utf8',signal}),product=await readFile(join(dirname(path),'idProduct'),{encoding:'utf8',signal});return `${vendor.trim().toLowerCase()}:${product.trim().toLowerCase()}`==='1d50:6177';}catch(error){signal.throwIfAborted();if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return false;throw error;}},
  readText:(path,signal)=>readFile(path,{encoding:'utf8',signal}),
  run:(command,signal)=>runUsbFlashCommand(command,repository,signal),
 };
}
