// GPL-3.0-or-later. Protocol derived from lib/katapult/flashtool.py
// Copyright (C) 2022 Eric Callahan.
import {createHash} from 'node:crypto';
import {crc16} from '../protocol/codec.ts';
export const KATAPULT_COMMAND={CONNECT:0x11,SEND_BLOCK:0x12,SEND_EOF:0x13,REQUEST_BLOCK:0x14,COMPLETE:0x15,GET_CANBUS_ID:0x16} as const;
export class KatapultRejectedError extends Error {
 readonly acknowledgement:number;
 constructor(acknowledgement:number){super(`Katapult rejected command: acknowledgement 0x${acknowledgement.toString(16)}`);this.name='KatapultRejectedError';this.acknowledgement=acknowledgement;}
}
export function katapultFrame(command:number,payload:Uint8Array=new Uint8Array()):Buffer {
 if(!Number.isInteger(command)||command<0||command>255||payload.length>1020||payload.length%4)throw new RangeError('Invalid Katapult frame');
 const out=Buffer.alloc(payload.length+8);out.set([1,0x88,command,payload.length/4]);out.set(payload,4);out.writeUInt16LE(crc16(out.subarray(2,-4))&0xffff,out.length-4);out.set([0x99,3],out.length-2);return out;
}
export function katapultReply(command:number,bytes:Uint8Array):Buffer {
 if(bytes.length>1028)throw new Error('Oversized Katapult response frame');
 const b=Buffer.from(bytes);
 if(b.length<8||b[0]!==1||b[1]!==0x88||b.length!==b[3]*4+8||b.at(-2)!==0x99||b.at(-1)!==3)throw new Error('Invalid Katapult response frame');
 if(b.readUInt16LE(b.length-4)!==(crc16(b.subarray(2,-4))&0xffff))throw new Error('Katapult response CRC mismatch');
 if(b[2]!==0xa0){
  if(![0xf1,0xf2,0xf3].includes(b[2])||![8,12].includes(b.length))throw new Error('Invalid Katapult rejection frame');
  if(b.length===12&&b.readUInt32LE(4)!==command)throw new Error('Katapult acknowledged wrong command');
  throw new KatapultRejectedError(b[2]);
 }
 if(b.length<12)throw new Error('Truncated Katapult acknowledgement');
 if(b.readUInt32LE(4)!==command)throw new Error('Katapult acknowledged wrong command');
 return b.subarray(8,-4);
}
export interface KatapultTransport {
 /** One logical request / complete response. timeoutMs bounds each attempt.
  * Owns framing, USB priming, deadlines and
  * cancellation; must not replay a command after uncertain write completion. */
 exchange(frame:Buffer,timeoutMs:number,signal:AbortSignal):Promise<Uint8Array>;
}
export interface KatapultInfo {protocol:readonly number[];start:number;blockSize:number;mcu:string;software:string;}
export function katapultInfo(payload:Uint8Array):KatapultInfo {
 const b=Buffer.from(payload);if(b.length<12)throw new Error('Truncated Katapult CONNECT response');
 const protocol=[b[2],b[1],b[0]],start=b.readUInt32LE(4),blockSize=b.readUInt32LE(8);
 if(![64,128,256,512].includes(blockSize))throw new Error('Invalid Katapult block size');
 let end=b.length;while(end>12&&b[end-1]===0)end--;
 const info=new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(12,end)),separator=info.indexOf('\0');
 const modern=protocol[0]>1||protocol[0]===1&&protocol[1]>=1;
 return {protocol,start,blockSize,mcu:modern&&separator>=0?info.slice(0,separator):info,software:modern&&separator>=0?info.slice(separator+1):'?'};
}
/** Nominal original upload -> EOF -> readback -> COMPLETE sequence.
 * Fails closed on timeout, busy or address mismatch; never retries writes.
 * Stream transports may retry a parser NACK on non-writing commands only.
 * The owner closes transport on every outcome. SHA-1 is compatibility integrity,
 * not firmware authenticity. No COMPLETE is sent after failed verification. */
export async function flashKatapult(image:Uint8Array,transport:KatapultTransport,signal:AbortSignal,options:{expectedMcu?:string;expectedUuid?:string}={}):Promise<{info:KatapultInfo;blocks:number;pages:number;sha1:string}> {
 signal.throwIfAborted();
 const {expectedMcu,expectedUuid}=options;
 if(!image.length||image.length>64*1024*1024||expectedMcu!==undefined&&(typeof expectedMcu!=='string'||!expectedMcu)||expectedUuid!==undefined&&(typeof expectedUuid!=='string'||!/^[a-f\d]{12}$/i.test(expectedUuid)))throw new RangeError('Invalid Katapult firmware or identity');
 const firmware=Buffer.from(image);
 const send=async(command:number,payload:Uint8Array=new Uint8Array(),timeout=2000)=>{signal.throwIfAborted();const response=await transport.exchange(katapultFrame(command,payload),timeout,signal);signal.throwIfAborted();return katapultReply(command,response);};
 const info=katapultInfo(await send(KATAPULT_COMMAND.CONNECT));
 if(expectedMcu!==undefined&&expectedMcu!==info.mcu)throw new Error('Katapult MCU does not match firmware');
 if(expectedUuid!==undefined){const id=await send(KATAPULT_COMMAND.GET_CANBUS_ID);if(id.length<6||id.subarray(0,6).toString('hex')!==expectedUuid.toLowerCase())throw new Error('Katapult UUID mismatch');}
 const blocks=Math.ceil(firmware.length/info.blockSize),paddedLength=blocks*info.blockSize;
 if(info.start+paddedLength>2**32)throw new RangeError('Katapult flash address overflow');
 const expectedHash=createHash('sha1');
 const block=(i:number)=>{const b=Buffer.alloc(info.blockSize,0xff);firmware.copy(b,0,i*info.blockSize,(i+1)*info.blockSize);return b;};
 const address=(i:number)=>{const p=Buffer.alloc(4);p.writeUInt32LE(info.start+i*info.blockSize);return p;};
 for(let i=0;i<blocks;i++){
  const data=block(i),addr=address(i);expectedHash.update(data);
  const response=await send(KATAPULT_COMMAND.SEND_BLOCK,Buffer.concat([addr,data]),5000);
  if(response.length!==4||!response.equals(addr))throw new Error('Katapult write address mismatch');
 }
 const eof=await send(KATAPULT_COMMAND.SEND_EOF);if(eof.length!==4)throw new Error('Invalid Katapult EOF response');const pages=eof.readUInt32LE();
 const actualHash=createHash('sha1');
 for(let i=0;i<blocks;i++){
  const addr=address(i),response=await send(KATAPULT_COMMAND.REQUEST_BLOCK,addr);
  if(response.length!==info.blockSize+4||!response.subarray(0,4).equals(addr))throw new Error('Katapult readback address or length mismatch');
  if(!response.subarray(4).equals(block(i)))throw new Error('Katapult readback bytes mismatch');actualHash.update(response.subarray(4));
 }
 const sha1=expectedHash.digest('hex');if(actualHash.digest('hex')!==sha1)throw new Error('Katapult SHA-1 mismatch');
 await send(KATAPULT_COMMAND.COMPLETE);return {info,blocks,pages,sha1};
}
