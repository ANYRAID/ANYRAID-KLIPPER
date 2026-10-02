// GPL-3.0-or-later. Port of scripts/flash-ar100.py; fixed A64 SRAM layout.
import {parseArgs} from 'node:util';
import {open,constants} from 'node:fs/promises';
import {createRequire} from 'node:module';
export type Ar100Mode='flash'|'flash-halt'|'bl31'|'bl31-halt'|'reset'|'halt';
export interface Ar100Plan {readonly mode:Ar100Mode;readonly filename?:string;}
export function parseAr100Args(args:readonly string[]):Ar100Plan|null{
 const {values,positionals}=parseArgs({args:[...args],allowPositionals:true,options:{reset:{type:'boolean'},halt:{type:'boolean'},bl31:{type:'boolean'},help:{type:'boolean',short:'h'}}});
 if(values.help)return null;
 if(positionals.length>1||values.reset&&(positionals.length||values.halt||values.bl31)||values.bl31&&!positionals.length||!positionals.length&&!values.reset&&!values.halt)throw new Error('Choose a firmware file, --halt or --reset; reset cannot be combined with writes');
 if(values.reset)return {mode:'reset'};if(!positionals.length)return {mode:'halt'};
 return {mode:values.bl31?(values.halt?'bl31-halt':'bl31'):(values.halt?'flash-halt':'flash'),filename:positionals[0]};
}
async function readFirmware(path:string,signal:AbortSignal):Promise<Buffer>{
 signal.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await file.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>65536n)throw new Error('Firmware must be a non-empty regular file of at most 65536 bytes');const data=Buffer.alloc(Number(before.size));let offset=0;while(offset<data.length){signal.throwIfAborted();const {bytesRead}=await file.read(data,offset,data.length-offset,offset);if(!bytesRead)throw new Error('Firmware truncated while reading');offset+=bytesRead;}const after=await file.stat({bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)throw new Error('Firmware changed while reading');signal.throwIfAborted();return data;}finally{await file.close();}
}
export async function runAr100Flash(args:readonly string[],signal:AbortSignal,output:(text:string)=>void,execute?:(mode:Ar100Mode,data:Buffer)=>void):Promise<void>{
 const plan=parseAr100Args(args);if(!plan){output('Usage: node scripts/flash-ar100.ts [--bl31] [--halt] firmware.bin\n       node scripts/flash-ar100.ts --reset | --halt\nAllwinner A64 only. Stop the printer before maintenance. Requires native AR100 addon and /dev/mem permission.\n');return;}
 const data=plan.filename?await readFirmware(plan.filename,signal):Buffer.alloc(0);signal.throwIfAborted();
 const native=execute??(createRequire(import.meta.url)('../../build/ar100-flash.node') as {execute:(mode:Ar100Mode,data:Buffer)=>void}).execute;
 output(plan.mode==='reset'?'Resetting AR100\n':plan.mode==='halt'?'Halting AR100\n':`Writing ${plan.mode.startsWith('bl31')?'bl31':'AR100 firmware'} (${data.length} bytes)\n`);signal.throwIfAborted();native(plan.mode,data);output('AR100 operation complete\n');
}
