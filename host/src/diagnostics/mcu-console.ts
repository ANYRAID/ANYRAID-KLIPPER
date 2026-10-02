// GPL-3.0-or-later. Offline diagnostic commands, derived from klippy/console.py.
import {open,rename,rm} from 'node:fs/promises';
import {basename,dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {consoleNumber,substituteConsoleArithmetic,type ConsoleNumber} from './console-arithmetic.ts';
import {formatDumpMessage} from './serial-dump.ts';
import {serialMcuDumpReader,mcuDumpPlan} from './mcu-dump.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import type {SerialSession,TimedCommandQueue} from '../protocol/serial-session.ts';
import type {TimedResponse} from '../protocol/clock-transport.ts';
export const mcuConsoleHelp='MCU commands and diagnostic controls: SET name value; DELAY clock command; FLOOD count seconds command; SUPPRESS name [oid]; DUMP address bytes [8|16|32]; FILEDUMP filename address bytes [8|16|32]; STATS; LIST; HELP.\nArithmetic in {braces} uses exact numbers, variables, and bounded operators; no calls or code execution.\n';
const integer=(text:string)=>{const v=consoleNumber(text);if(v.denominator!==1n)throw new TypeError('Integer required');return v.numerator;};
export class McuConsole {
 readonly #session:SerialSession;readonly #queue:TimedCommandQueue;readonly #write:(text:string)=>Promise<void>;
 readonly #variables=new Map<string,ConsoleNumber|string>();readonly #suppressed=new Set<string>();readonly #start=serialClock.now();#busy=false;
 constructor(session:SerialSession,write:(text:string)=>Promise<void>){this.#session=session;this.#queue=session.diagnosticCommandQueue();this.#write=write;}
 response(response:TimedResponse):string|undefined{
  const {message}=response;if(this.#suppressed.has(message.name)||this.#suppressed.has(message.name+':'+message.parameters.oid))return;
  return (response.receiveTime-this.#start).toFixed(3).padStart(7,'0')+': '+formatDumpMessage(message)+'\n';
 }
 #environment(){const values=new Map<string,ConsoleNumber|bigint>();for(const [key,v] of this.#variables)if(typeof v!=='string')values.set(key,v);values.set('clock',this.#session.clock.sync.getClock(serialClock.now()));values.set('freq',consoleNumber(String(this.#session.dictionary.constant('CLOCK_FREQ'))));return values;}
 async execute(input:string,signal:AbortSignal):Promise<void>{
  if(this.#busy)throw new Error('Console command already running');this.#busy=true;
  try{signal.throwIfAborted();this.#session.assertActive();if(input.length>8192)throw new RangeError('Console line too long');
   const source=input.trim().startsWith('SUPPRESS #')?input.trim():input.split('#',1)[0].trim();if(!source)return;
   const line=substituteConsoleArithmetic(source.replace(/\{\s*([A-Za-z_][A-Za-z_0-9]*)\s*\}/g,(match,name)=>{const v=this.#variables.get(name);return typeof v==='string'?v:match;}),this.#environment()),parts=line.split(/\s+/),[action,...args]=parts;
   if(action==='HELP'){if(args.length)throw new Error('HELP takes no arguments');await this.#write(mcuConsoleHelp);return;}
   if(action==='SET'){
    if(args.length!==2||!/^[A-Za-z_][A-Za-z_0-9]*$/.test(args[0])||['clock','freq'].includes(args[0])||!this.#variables.has(args[0])&&this.#variables.size>=256)throw new Error('SET requires an available variable name and one value');
    let value:ConsoleNumber|string;try{value=consoleNumber(args[1]);}catch{if(!/^[A-Za-z_][A-Za-z_0-9]*$/.test(args[1]))throw new TypeError('SET requires a number or identifier');value=args[1];}this.#variables.set(args[0],value);return;
   }
   if(action==='SUPPRESS'){if(args.length<1||args.length>2||!/^(?:[A-Za-z_][A-Za-z_0-9]*|#output|#unknown)$/.test(args[0])||this.#suppressed.size>=512)throw new Error('Invalid SUPPRESS route');const oid=args[1]===undefined?undefined:integer(args[1]);if(oid!==undefined&&(oid<0n||oid>254n))throw new RangeError('Invalid OID');this.#suppressed.add(args[0]+(oid===undefined?'':':'+oid));return;}
   if(action==='STATS'){if(args.length)throw new Error('STATS takes no arguments');await this.#write(this.#session.transportStats+'\n');return;}
   if(action==='LIST'){if(args.length)throw new Error('LIST takes no arguments');const env=this.#environment();await this.#write('Available MCU commands:\n'+this.#session.dictionary.commandFormats.join('\n')+'\n'+mcuConsoleHelp+'Variables:\n'+[...new Set([...this.#variables.keys(),...env.keys()])].sort().map(k=>{const v=this.#variables.get(k)??env.get(k)!;return k+'='+ (typeof v==='string'||typeof v==='bigint'?v:v.numerator+'/'+v.denominator);}).join('\n')+'\n');return;}
   if(action==='DUMP'||action==='FILEDUMP'){await this.#dump(action==='FILEDUMP',args,signal);return;}
   let command=line,min=0n,req=0n,count=1,step=0n;
   if(action==='DELAY'){if(args.length<2)throw new Error('DELAY requires clock and command');min=integer(args[0]);req=min;command=args.slice(1).join(' ');}
   if(action==='FLOOD'){
    if(args.length<3)throw new Error('FLOOD requires count, seconds and command');const n=integer(args[0]),seconds=consoleNumber(args[1]),freq=consoleNumber(String(this.#session.dictionary.constant('CLOCK_FREQ')));
    if(n<1n||n>10000n||seconds.numerator<0n)throw new RangeError('Invalid FLOOD bounds');count=Number(n);step=seconds.numerator*freq.numerator/(seconds.denominator*freq.denominator);min=this.#session.clock.sync.getClock(serialClock.now())+freq.numerator/(5n*freq.denominator);req=min+step;
    if(this.#session.clock.sync.systemTime(req+step*(n-1n))>serialClock.now()+60)throw new RangeError('FLOOD exceeds 60 second horizon');command=args.slice(2).join(' ');
   }
   // Encode and validate the full schedule before submitting the first command.
   const payload=this.#session.dictionary.encodeCommand(command);if(min<0n||req<min||req+step*BigInt(count-1)>=0x7fffffffffffffffn)throw new RangeError('Invalid console clocks');
   for(let i=0;i<count;i++){signal.throwIfAborted();await this.#queue.send(payload,min,req,signal);min+=step;req+=step;}
  }finally{this.#busy=false;}
 }
 async #dump(file:boolean,args:string[],signal:AbortSignal){
  const filename=file?args.shift():undefined;if(args.length<2||args.length>3||file&&!filename)throw new Error('DUMP requires address, length and optional width');
  const start=integer(args[0]),length=integer(args[1]);if(start<0n||start>0xffffffffn||length<1n||length>1048576n)throw new RangeError('Dump is limited to 1 MiB in uint32 address space');
  const plan=mcuDumpPlan({start:Number(start),length:Number(length)}),bits=args[2]===undefined?plan.width*8:Number(args[2]);if(![8,16,32].includes(bits))throw new RangeError('Dump width must be 8, 16 or 32');
  const width=bits/8,order=(width===4?2:width===2?1:0),reads=Math.ceil(plan.length/width);if(start+BigInt(reads*width)>0x100000000n)throw new RangeError('Dump read crosses uint32 boundary');
  const read=serialMcuDumpReader(this.#session),temporary=filename?join(dirname(filename),'.'+basename(filename)+'.'+randomUUID()+'.tmp'):undefined;let owned=false;
  try{const handle=temporary?await open(temporary,'wx',0o600):undefined;owned=!!handle;
   try{for(let offset=0;offset<plan.length;offset+=16){const size=Math.min(16,plan.length-offset),buffer=Buffer.alloc(Math.ceil(size/width)*width),words:string[]=[];
    for(let i=0;i<buffer.length;i+=width){signal.throwIfAborted();const value=await read(order,plan.start+offset+i,signal);if(!Number.isInteger(value)||value<0||value>0xffffffff)throw new Error('Invalid debug result');words.push(value.toString(16).padStart(8,'0'));for(let b=0;b<width;b++)buffer[i+b]=(value>>>(b*8))&255;}
    signal.throwIfAborted();if(handle)await handle.writeFile(buffer.subarray(0,size),{signal});else await this.#write((plan.start+offset).toString(16).padStart(8,'0')+'  '+(bits===32?words.join(' '):[...buffer.subarray(0,size)].map(b=>b.toString(16).padStart(2,'0')).join(' ').padEnd(47)+'  |'+[...buffer.subarray(0,size)].map(b=>b>=32&&b<127?String.fromCharCode(b):'.').join('')+'|')+'\n');
   }if(handle)await handle.sync();}finally{await handle?.close();}
   if(temporary){signal.throwIfAborted();await rename(temporary,filename!);await this.#write('Wrote '+plan.length+" bytes to '"+filename+"'\n");}
  }finally{if(owned)await rm(temporary!,{force:true});}
 }
}
