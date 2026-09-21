// GPL-3.0-or-later. Based on scripts/dump_mcu.py (Eric Callahan, 2022).
import {open,rename,rm} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import type {SerialSession} from '../protocol/serial-session.ts';
export interface McuDumpRange {readonly start:number;readonly length:number;}
export type McuDumpReader=(order:0|1|2,address:number,signal:AbortSignal)=>Promise<number>;
export function mcuDumpPlan(range:McuDumpRange):{start:number;length:number;order:0|1|2;width:number}{
 const {start,length}=range;
 if(!Number.isSafeInteger(start)||start<0||start>0xffffffff||!Number.isSafeInteger(length)||length<=0||length>0x100000000-start)throw new RangeError('MCU dump must fit the uint32 address space');
 const order=([2,0,1,0] as const)[(start%4)|(length%4)];return {start,length,order,width:1<<order};
}
/** Reuses dictionary validation, ACK/response matching, deadlines and cancellation.
 * The caller owns this diagnostic session and its device shutdown policy. */
export function serialMcuDumpReader(session:SerialSession):McuDumpReader{
 const command=session.dictionary.lookup('debug_read order=%c addr=%u'),response=session.dictionary.lookup('debug_result val=%u');
 return async(order,address,signal)=>{const result=await session.query(session.dictionary.encode(command.name,{order,addr:address}),response.name,signal,{retries:0});return result.message.parameters.val as number;};
}
/** Sequential protocol reads; at most 64 KiB of output storage. Each yielded buffer
 * belongs to the caller and is never reused. A debug read can have hardware side
 * effects for MMIO addresses; this function does not declare arbitrary reads safe. */
export async function* mcuDumpChunks(reader:McuDumpReader,range:McuDumpRange,signal:AbortSignal):AsyncGenerator<Buffer>{
 const {start,length,order,width}=mcuDumpPlan(range);signal.throwIfAborted();
 for(let offset=0;offset<length;){
  const chunk=Buffer.allocUnsafe(Math.min(65536,length-offset));
  for(let i=0;i<chunk.length;i+=width){
   signal.throwIfAborted();const value=await reader(order,start+offset+i,signal);signal.throwIfAborted();
   if(!Number.isInteger(value)||value<0||value>0xffffffff)throw new RangeError('Invalid MCU debug uint32 result');
   for(let b=0;b<width;b++)chunk[i+b]=(value>>> (8*b))&255;
  }
  offset+=chunk.length;yield chunk;
 }
}
/** Publish only after every query and file write succeeds. No partial dump replaces
 * an existing destination. Atomic rename is not a power-loss durability guarantee. */
export async function dumpMcuToFile(reader:McuDumpReader,range:McuDumpRange,filename:string,signal:AbortSignal):Promise<void>{
 const plan=mcuDumpPlan(range);signal.throwIfAborted();const temporary=join(dirname(filename),`.${basename(filename)}.${randomUUID()}.tmp`);let owned=false;
 try{
  const file=await open(temporary,'wx',0o600);owned=true;
  try{for await(const chunk of mcuDumpChunks(reader,plan,signal))await file.writeFile(chunk,{signal});await file.sync();}finally{await file.close();}
  signal.throwIfAborted();await rename(temporary,filename);
 }finally{if(owned)await rm(temporary,{force:true});}
}
