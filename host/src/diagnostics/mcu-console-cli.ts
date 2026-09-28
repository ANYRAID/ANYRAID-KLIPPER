import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import type {Readable,Writable} from 'node:stream';
import type {SerialSession} from '../protocol/serial-session.ts';
import type {McuConsole} from './mcu-console.ts';
import {ConsoleFrames} from './webhook-console.ts';
export const consoleHelp='Usage: node scripts/console.ts [--pipe | --canbus_iface IFACE] [-b BAUD] [-i NODE_ID] [--no-bootloader] DEVICE\nMCU diagnostic console: SET, DELAY, FLOOD, SUPPRESS, DUMP, FILEDUMP, STATS, LIST, HELP.\nExclusive offline commissioning only. Closing the host does not physically stop already queued MCU actions.\n';
export function parseConsoleArgs(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,options:{help:{type:'boolean',short:'h'},verbose:{type:'boolean',short:'v'},baud:{type:'string',short:'b'},canbus_iface:{type:'string',short:'c'},canbus_nodeid:{type:'string',short:'i'},pipe:{type:'boolean'},'no-bootloader':{type:'boolean'},'connect-timeout':{type:'string'}}});
 if(values.help)return;if(positionals.length!==1)throw new Error(consoleHelp);
 const natural=(v:string)=>{if(!/^\d+$/.test(v)||!Number.isSafeInteger(Number(v)))throw new Error('Invalid integer option');return Number(v);};
 const baud=natural(values.baud??'250000'),nodeId=natural(values.canbus_nodeid??'64'),timeout=natural(values['connect-timeout']??'60000'),can=values.canbus_iface,device=can?positionals[0]:resolve(positionals[0]);
 if(baud<1||baud>4000000||nodeId>255||timeout<1||timeout>60000||device.includes('\0'))throw new RangeError('Invalid console connection limits');
 if(can!==undefined&&(!/^[A-Za-z0-9_.:-]{1,15}$/.test(can)||!/^(?:0x)?[0-9a-f]{1,12}$/i.test(device)||values.pipe||values.baud||values['no-bootloader'])||can===undefined&&values.canbus_nodeid!==undefined)throw new Error('Conflicting console transports');
 if(values.pipe&&values.baud)throw new Error('Pipe does not accept UART baud');
 return {verbose:!!values.verbose,device,baud,nodeId,timeout,can,pipe:values.pipe??(values.baud===undefined&&(device.startsWith('/tmp/')||device.startsWith('/dev/rpmsg_'))),leaveBootloader:!values['no-bootloader']};
}
export async function runMcuConsole(args:string[],input:Readable,output:Writable,signal:AbortSignal){
 const options=parseConsoleArgs(args);if(!options){output.write(consoleHelp);return;}
 const abort=new AbortController(),lifetime=AbortSignal.any([signal,abort.signal]);let session:SerialSession|undefined,consoleOwner:McuConsole|undefined,tail=Promise.resolve(),queued=0,closing=false,unwatch:(()=>void)|undefined;
 const fail=(error:unknown)=>{abort.abort(error);input.destroy();};
 const write=(text:string):Promise<void>=>{
  const size=Buffer.byteLength(text);if(queued+size>1024*1024){const error=Error('Console output backlog exceeded');fail(error);return Promise.reject(error);}queued+=size;
  const pending=tail.then(()=>new Promise<void>((done,reject)=>{lifetime.throwIfAborted();let settled=false;const finish=(error?:unknown)=>{if(settled)return;settled=true;clearTimeout(timer);lifetime.removeEventListener('abort',cancel);error===undefined?done():reject(error);},cancel=()=>finish(lifetime.reason),timer=setTimeout(()=>finish(Error('Console output stalled')),10000);lifetime.addEventListener('abort',cancel,{once:true});try{output.write(text,error=>finish(error??undefined));}catch(error){finish(error);}})).finally(()=>{queued-=size;});tail=pending;void pending.catch(fail);return pending;
 };
 const onError=(error:Error)=>fail(error),onAbort=()=>input.destroy();output.on('error',onError);input.on('error',onError);lifetime.addEventListener('abort',onAbort,{once:true});
 try{
  lifetime.throwIfAborted();await write('Connecting to MCU..\n');const hooks={diagnosticCommands:true,async stopDevice(){},onMessage:(response:Parameters<McuConsole['response']>[0])=>{const text=consoleOwner?.response(response);if(text)void write(text).catch(fail);}};
  const connecting=AbortSignal.any([lifetime,AbortSignal.timeout(options.timeout)]);
  if(options.can){const {connectCAN}=await import('../protocol/can.ts');session=await connectCAN(options.can,options.device,{...hooks,nodeId:options.nodeId,timeoutMs:options.timeout},connecting);}
  else if(options.pipe){const {connectPipe}=await import('../protocol/pipe.ts');session=await connectPipe(options.device,hooks,connecting);}
  else{const {connectUART}=await import('../protocol/uart.ts');session=await connectUART(options.device,{...hooks,baud:options.baud,leaveBootloader:options.leaveBootloader},connecting);}
  const {McuConsole,mcuConsoleHelp}=await import('./mcu-console.ts');consoleOwner=new McuConsole(session,write);unwatch=session.observeClose(cause=>{if(!closing)fail(cause);});await write('Connected: '+session.dictionary.version+'\n'+mcuConsoleHelp);if(options.verbose)await write('MCU config: '+JSON.stringify(session.dictionary.constants)+'\n');
  const frames=new ConsoleFrames(10,8192),decoder=new TextDecoder('utf-8',{fatal:true}),line=async(bytes:Buffer)=>{lifetime.throwIfAborted();try{await consoleOwner!.execute(decoder.decode(bytes),lifetime);}catch(error){lifetime.throwIfAborted();session!.assertActive();await write('Error: '+(error instanceof Error?error.message:String(error))+'\n');}};
  for await(const chunk of input)for(const bytes of frames.push(Buffer.from(chunk)))await line(bytes);const last=frames.finish();if(last)await line(last);
  lifetime.throwIfAborted();await session.waitForAcknowledgements(lifetime);await tail;lifetime.throwIfAborted();
 }finally{closing=true;unwatch?.();input.destroy();await session?.stop();lifetime.removeEventListener('abort',onAbort);output.removeListener('error',onError);input.removeListener('error',onError);}
}
