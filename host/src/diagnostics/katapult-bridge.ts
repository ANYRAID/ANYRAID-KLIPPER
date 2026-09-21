// fasthash64: Copyright (C) 2012 Zilong Tan (eric.zltan@gmail.com).
// Port based on lib/katapult/flashtool.py, Copyright (C) 2022 Eric Callahan.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
// Filesystem bridge discovery follows the GPL-3.0-or-later Katapult tool.
import {readFile,readdir,stat} from 'node:fs/promises';
import {basename,isAbsolute,join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const mask=(1n<<64n)-1n,multiplier=0x880355f21e6d1965n;
function mix(value:bigint){value^=value>>23n;value=value*0x2127599bf4325c37n&mask;return value^value>>47n;}
export function katapultFastHash64(input:Uint8Array,seed:bigint):bigint{
 if(typeof seed!=='bigint'||seed<0n||seed>mask)throw new RangeError('Invalid fasthash64 seed');
 const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);let hash=seed^(BigInt(bytes.length)*multiplier&mask),offset=0;
 for(;offset+8<=bytes.length;offset+=8)hash=(hash^mix(bytes.readBigUInt64LE(offset)))*multiplier&mask;
 if(offset<bytes.length){let tail=0n;for(let i=bytes.length-1;i>=offset;i--)tail=tail<<8n|BigInt(bytes[i]);hash=(hash^mix(tail))*multiplier&mask;}
 return mix(hash);
}
export function usbSerialToCanUuid(serial:string):string{
 // Match Python bytes.fromhex ASCII whitespace between complete byte pairs.
 if(typeof serial!=='string'||serial.length>1024||!/^[ \t\r\n\v\f]*(?:[a-f\d]{2}[ \t\r\n\v\f]*)*$/i.test(serial))throw new TypeError('Invalid USB chip serial');
 const hash=katapultFastHash64(Buffer.from(serial.replace(/[ \t\r\n\v\f]/g,''),'hex'),0xa16231a7n),bytes=Buffer.alloc(8);bytes.writeBigUInt64LE(hash);return bytes.subarray(0,6).toString('hex');
}
export interface UsbBridge {path:string;serial:string;uuid:string;}
export interface UsbBridgeRoots {usb?:string;dev?:string;}
async function text(path:string,signal:AbortSignal){signal.throwIfAborted();try{return (await readFile(path,{encoding:'utf8',signal})).trim().toLowerCase();}catch(error){signal.throwIfAborted();if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return undefined;throw error;}}
async function entries(path:string,signal:AbortSignal){signal.throwIfAborted();try{return await readdir(path);}catch(error){signal.throwIfAborted();if(['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))return [];throw error;}}
async function usbInfo(path:string,signal:AbortSignal){const vendor=await text(join(path,'idVendor'),signal),product=await text(join(path,'idProduct'),signal);return {id:vendor&&product?`${vendor}:${product}`:'',manufacturer:await text(join(path,'manufacturer'),signal)};}
function root(path:string){if(!isAbsolute(path)||path.includes('\0'))throw new Error('Invalid USB bridge root');return path;}
/** Read-only association of a CAN interface and exact requested UUID to GS USB. */
export async function findKatapultBridge(name:string,uuid:string,signal:AbortSignal,roots:UsbBridgeRoots={}):Promise<UsbBridge|undefined>{
 signal.throwIfAborted();if(!/^[A-Za-z0-9_.:-]{1,15}$/.test(name)||!/^[a-f\d]{12}$/i.test(uuid))throw new TypeError('Invalid bridge interface or UUID');
 const directory=root(roots.usb??'/sys/bus/usb/devices'),matches:UsbBridge[]=[];
 for(const nameEntry of await entries(directory,signal)){
  const path=join(directory,nameEntry);if(await text(join(path,'bDeviceClass'),signal)===undefined)continue;
  const info=await usbInfo(path,signal);if(info.id!=='1d50:606f'||info.manufacturer!=='klipper')continue;
  let associated=false;
  for(const child of await entries(path,signal)){if(child.startsWith(nameEntry+':')&&(await entries(join(path,child,'net'),signal)).includes(name)){associated=true;break;}}
  if(!associated)continue;
  const serial=await text(join(path,'serial'),signal);if(!serial)continue;
  const actual=usbSerialToCanUuid(serial);if(actual===uuid.toLowerCase())matches.push({path,serial,uuid:actual});
 }
 signal.throwIfAborted();if(matches.length>1)throw new Error('Ambiguous USB-CAN bridge identity');return matches[0];
}
export interface BridgeWait {sleep(ms:number,signal:AbortSignal):Promise<void>;}
/** Read-only wait after caller has requested reboot. Never reports a non-Katapult
 * replacement as success or selects an arbitrary tty when several appear. */
export async function waitKatapultBridge(bridge:UsbBridge,signal:AbortSignal,roots:UsbBridgeRoots={},clock:BridgeWait={sleep:async(ms,s)=>{await delay(ms,undefined,{signal:s});}}):Promise<string>{
 signal.throwIfAborted();const dev=root(roots.dev??'/dev'),path=root(bridge.path),name=basename(path);
 for(let attempt=0;attempt<8;attempt++){
  await clock.sleep(500,signal);signal.throwIfAborted();const info=await usbInfo(path,signal);if(!info.id||info.id==='1d50:606f')continue;
  await clock.sleep(500,signal);signal.throwIfAborted();const settled=await usbInfo(path,signal);
  if(settled.id!==info.id)throw new Error('USB bridge changed during reconnect');
  if(settled.id!=='1d50:6177'&&settled.manufacturer!=='katapult')throw new Error('USB bridge did not reconnect as Katapult');
  const paths:string[]=[];
  for(const child of await entries(path,signal)){if(!child.startsWith(name+':'))continue;for(const tty of await entries(join(path,child,'tty'),signal)){if(/^tty[^/\0]+$/.test(tty))paths.push(join(dev,tty));}}
  const unique=[...new Set(paths)];if(unique.length!==1)throw new Error('USB bridge tty is missing or ambiguous');
  // Existence is checked here; the owning native UART open validates termios.
  await stat(unique[0]);signal.throwIfAborted();return unique[0];
 }
 throw new Error('USB-CAN bridge reconnect timed out');
}
