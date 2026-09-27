import {parseArgs} from 'node:util';
import {resolve,join} from 'node:path';
import {open,constants} from 'node:fs/promises';
import {sdFlashBoards,sdBoardDefinition} from './sd-boards.ts';
import type {SDFlashRequest,flashSDCard} from './sd-flash.ts';
export function parseSDFlashArgs(args:readonly string[],repository:string){
 const {values:v,positionals:p}=parseArgs({args:[...args],allowPositionals:true,options:{help:{type:'boolean',short:'h'},list:{type:'boolean',short:'l'},check:{type:'boolean',short:'c'},'fast-spi':{type:'boolean',short:'s'},baud:{type:'string',short:'b'},firmware:{type:'string',short:'f'},dictionary:{type:'string',short:'d'}}});
 if(v.help)return {mode:'help' as const};if(v.list){if(p.length)throw new Error('Board list takes no positional arguments');return {mode:'list' as const};}
 if(p.length<2||p.length>3||v.firmware&&p.length===3)throw new Error('Expected device and board, with at most one firmware file');sdBoardDefinition(p[1]);
 const baud=Number(v.baud??250000);if(!/^\d+$/.test(v.baud??'250000')||!Number.isSafeInteger(baud)||baud<1||baud>0xffffffff)throw new Error('Invalid serial baud');
 const explicit=v.firmware??p[2];return {mode:'flash' as const,device:resolve(p[0]),board:p[1],baud,firmware:resolve(explicit??join(repository,'out/klipper.bin')),dictionary:v.dictionary?resolve(v.dictionary):explicit===undefined?join(repository,'out/klipper.dict'):undefined,verifyOnly:v.check??false,fast:v['fast-spi']??false};
}
async function readInput(path:string,limit:number,signal:AbortSignal){
 signal.throwIfAborted();const file=await open(path,constants.O_RDONLY|constants.O_NONBLOCK);
 try{const before=await file.stat({bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(limit))throw new Error('Invalid flash input file size or type');const bytes=Buffer.alloc(Number(before.size)+1);let length=0;while(length<bytes.length){signal.throwIfAborted();const read=await file.read(bytes,length,bytes.length-length,null);if(!read.bytesRead)break;length+=read.bytesRead;}const after=await file.stat({bigint:true});signal.throwIfAborted();if(length!==Number(before.size)||after.size!==before.size||after.mtimeNs!==before.mtimeNs||after.ctimeNs!==before.ctimeNs)throw new Error('Flash input changed while reading');return bytes.subarray(0,length);}finally{await file.close();}
}
type Execute=(device:string,baud:number,request:SDFlashRequest,signal:AbortSignal)=>ReturnType<typeof flashSDCard>;
export async function runSDFlash(args:readonly string[],repository:string,signal:AbortSignal,output:(text:string)=>void,execute?:Execute){
 const parsed=parseSDFlashArgs(args,repository);signal.throwIfAborted();if(parsed.mode==='help'){output('Usage: node scripts/flash-sdcard.ts [-l] [-c] [-s] [-b baud] [-f firmware] [-d dictionary] device board\nOffline maintenance only: stop the printer host and make actuators safe first. Closing UART does not stop motors or heaters.\nExit 2 means upload complete but manual power cycling and a later -c check are required.\n');return 0;}if(parsed.mode==='list'){output(sdFlashBoards.join('\n')+'\n');return 0;}
 const firmware=await readInput(parsed.firmware,64*1024*1024,signal),dictionary=parsed.dictionary?await readInput(parsed.dictionary,4*1024*1024,signal):undefined,board=sdBoardDefinition(parsed.board);
 const timestamp=board.requires_unique_fw_name?new Date().toISOString().replace(/[-:T]/g,'').slice(0,14):undefined;
 const request={board:parsed.board,firmware,dictionary,verifyOnly:parsed.verifyOnly,fast:parsed.fast,timestamp};
 const run:Execute=execute??(async(device,baud,request,s)=>{
  const {sdFlashDevicePath,sdFlashUART}=await import('./sd-flash-uart.ts'),{flashSDCard}=await import('./sd-flash.ts');const path=await sdFlashDevicePath(device,s);
  // Standalone offline maintenance has no configured actuator owner. The
  // operator establishes physical safety before invocation; UART closure is
  // resource cleanup only and is never advertised as a physical stop.
  return flashSDCard(sdFlashUART(path,{baud,async stopDevice(){}}),request,s);
 });
 const result=await run(parsed.device,parsed.baud,request,signal);signal.throwIfAborted();output(JSON.stringify(result)+'\n');return result.state==='power-cycle-required'?2:0;
}
