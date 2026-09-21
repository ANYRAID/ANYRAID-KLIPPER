// GPL-3.0-or-later. Klipper embedded dictionary discovery, replacing
// CanFlasher._check_binary in lib/katapult/flashtool.py (Eric Callahan, 2022).
import {inflate} from 'node:zlib';
import {setImmediate as yieldLoop} from 'node:timers/promises';
import {flashKatapult,type KatapultTransport} from './katapult.ts';
export interface FirmwareIdentity {offset:number;mcu?:string;version?:string;}
const MAX_IMAGE=64*1024*1024,MAX_DICTIONARY=4*1024*1024,MAX_CANDIDATES=4096;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Scans any filename, only accepts app=Klipper. Caller must keep image stable.
 * RFC1950 header prefilter avoids throwing a decompressor error at every byte.
 * No authenticity claim; the dictionary is metadata supplied by the firmware. */
export async function findFirmwareIdentity(image:Uint8Array,signal:AbortSignal):Promise<FirmwareIdentity|undefined>{
 signal.throwIfAborted();if(!image.length||image.length>MAX_IMAGE)throw new RangeError('Invalid firmware size');
 const bytes=Buffer.from(image.buffer,image.byteOffset,image.byteLength);let candidates=0;
 for(let offset=0;offset+1<bytes.length;offset++){
  if(offset%65536===0){await yieldLoop(undefined,{signal});signal.throwIfAborted();}
  const cmf=bytes[offset],flg=bytes[offset+1];
  if((cmf&15)!==8||(cmf>>>4)>7||(cmf*256+flg)%31!==0||(flg&32)!==0)continue;
  if(++candidates>MAX_CANDIDATES)throw new Error('Firmware compressed candidate limit exceeded');
  let raw:Buffer;
  try{raw=await new Promise<Buffer>((resolve,reject)=>inflate(bytes.subarray(offset),{maxOutputLength:MAX_DICTIONARY},(error,result)=>error?reject(error):resolve(result)));}
  catch(error){signal.throwIfAborted();if((error as NodeJS.ErrnoException).code==='ERR_BUFFER_TOO_LARGE')throw new Error('Firmware dictionary exceeds decompression limit',{cause:error});if(['Z_DATA_ERROR','Z_BUF_ERROR'].includes((error as NodeJS.ErrnoException).code??''))continue;throw error;}
  signal.throwIfAborted();let data:unknown;
  try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{continue;}
  if(!object(data)||data.app!=='Klipper')continue;
  if(data.config!==undefined&&!object(data.config))throw new Error('Invalid Klipper firmware config');
  const mcu=(data.config as Record<string,unknown>|undefined)?.MCU,version=data.version;
  if(mcu!==undefined&&(typeof mcu!=='string'||!mcu)||version!==undefined&&typeof version!=='string')throw new Error('Invalid Klipper firmware identity');
  return {offset,mcu:mcu as string|undefined,version:version as string|undefined};
 }
 return undefined;
}
/** Snapshot before scanning and use those same bytes for programming. */
export async function flashKatapultFirmware(image:Uint8Array,transport:KatapultTransport,signal:AbortSignal,options:{expectedMcu?:string;expectedUuid?:string}={}){
 signal.throwIfAborted();if(!image.length||image.length>MAX_IMAGE)throw new RangeError('Invalid firmware size');
 options={...options};
 const snapshot=Buffer.from(image),identity=await findFirmwareIdentity(snapshot,signal);
 if(options.expectedMcu!==undefined&&identity?.mcu!==undefined&&options.expectedMcu!==identity.mcu)throw new Error('Requested MCU does not match firmware dictionary');
 const result=await flashKatapult(snapshot,transport,signal,{...options,expectedMcu:identity?.mcu??options.expectedMcu});
 return {...result,identity};
}
