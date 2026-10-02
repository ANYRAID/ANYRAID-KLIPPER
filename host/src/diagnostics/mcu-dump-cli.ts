import {parseArgs} from 'node:util';
import {lstat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {homedir} from 'node:os';
import {dumpMcuToFile,mcuDumpPlan,serialMcuDumpReader} from './mcu-dump.ts';
import type {SerialSession} from '../protocol/serial-session.ts';
export const mcuDumpHelp='Usage: node scripts/dump_mcu.ts [options] DEVICE OUTFILE\n  -b, --baud N             UART baud (default 250000)\n  -c, --canbus_iface NAME  CAN interface; DEVICE is UUID\n  -i, --canbus_nodeid N    CAN node ID (default 64)\n  -s, --read_start N       Start address (default 0)\n  -l, --read_length N      Byte count (default 0x400)\n      --pipe              Prepared PTY/RPMsg stream\n      --no-bootloader     Omit UART AVR leave sequence\n      --connect-timeout N Connection deadline ms (default 60000)\n  -h, --help              Show help\nOffline diagnostics only. Memory reads may have MMIO side effects.\n';
export function parseMcuDumpArgs(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{baud:{type:'string',short:'b'},canbus_iface:{type:'string',short:'c'},canbus_nodeid:{type:'string',short:'i'},read_start:{type:'string',short:'s'},read_length:{type:'string',short:'l'},pipe:{type:'boolean'},'no-bootloader':{type:'boolean'},'connect-timeout':{type:'string'},help:{type:'boolean',short:'h'}}});
 if(values.help)return undefined;if(positionals.length!==2)throw new Error(mcuDumpHelp);
 const integer=(s:string)=>{if(!/^(?:0x[\da-f]+|0b[01]+|0o[0-7]+|\d+)$/i.test(s)||!Number.isSafeInteger(Number(s)))throw new TypeError('Invalid integer option');return Number(s);};
 const range=mcuDumpPlan({start:integer(values.read_start??'0'),length:integer(values.read_length??'0x400')}),baud=integer(values.baud??'250000'),nodeId=integer(values.canbus_nodeid??'64'),timeoutMs=integer(values['connect-timeout']??'60000');
 if(baud<1||baud>4000000||nodeId>255||timeoutMs<1||timeoutMs>60000)throw new RangeError('Invalid connection limits');
 const expand=(path:string)=>path.startsWith('~/')?join(homedir(),path.slice(2)):path;
 const canInterface=values.canbus_iface,device=canInterface===undefined?resolve(expand(positionals[0])):positionals[0],filename=resolve(expand(positionals[1]));
 if(canInterface!==undefined&&(!/^[A-Za-z0-9_.:-]{1,15}$/.test(canInterface)||! /^(?:0x)?[0-9a-f]{1,12}$/i.test(device)||values.pipe||values['no-bootloader']||values.baud))throw new Error('Invalid or conflicting CAN options');
 if(canInterface===undefined&&values.canbus_nodeid!==undefined)throw new Error('CAN node ID requires --canbus_iface');
 if(!device||device.includes('\0')||filename.includes('\0')||device===filename)throw new Error('Invalid device or output path');
 return {range,baud,nodeId,timeoutMs,canInterface,device,filename,pipe:values.pipe??(device.startsWith('/dev/rpmsg_')||device.startsWith('/tmp/')),leaveBootloader:!values['no-bootloader']};
}
export async function runMcuDump(args:string[],signal:AbortSignal,output:(text:string)=>void):Promise<void>{
 const options=parseMcuDumpArgs(args);if(!options){output(mcuDumpHelp);return;}signal.throwIfAborted();
 try{const target=await lstat(options.filename);if(!target.isFile())throw new Error('Dump output must be a regular file or absent');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
 // Diagnostics never configure actuators. Cleanup closes our transport only;
 // it cannot establish or certify a physical emergency stop for existing activity.
 const lifecycle={async stopDevice(){}};let session:SerialSession|undefined;
 try{
  output('Connecting to MCU..\n');
  if(options.canInterface!==undefined){const {connectCAN}=await import('../protocol/can.ts');session=await connectCAN(options.canInterface,options.device,{...lifecycle,nodeId:options.nodeId,timeoutMs:options.timeoutMs},signal);}
  else{const connecting=AbortSignal.any([signal,AbortSignal.timeout(options.timeoutMs)]);if(options.pipe){const {connectPipe}=await import('../protocol/pipe.ts');session=await connectPipe(options.device,lifecycle,connecting);}else{const {connectUART}=await import('../protocol/uart.ts');session=await connectUART(options.device,{...lifecycle,baud:options.baud,leaveBootloader:options.leaveBootloader},connecting);}}
  signal.throwIfAborted();output(`Connected; reading ${options.range.length} bytes at 0x${options.range.start.toString(16)}\n`);
  await dumpMcuToFile(serialMcuDumpReader(session),options.range,options.filename,signal);
 }finally{await session?.stop();}
 output(`Wrote ${options.range.length} bytes to '${options.filename}'\nMCU Dump Complete\n`);
}
