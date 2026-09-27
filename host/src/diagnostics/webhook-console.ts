// GPL-3.0-or-later. Based on the former Klipper scripts/whconsole.py (Kevin O'Connor, 2020).
import {createConnection,type Socket} from 'node:net';
import {Readable,Writable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
/** Bounded, amortized-linear byte framing, including split UTF-8 sequences.
 * ownedChunks transfers immutable chunk ownership: complete frames may share
 * its backing buffer. Default callers retain ownership and receive copies. */
export class ConsoleFrames {
 #buffer=Buffer.alloc(0);#length=0;
 readonly delimiter:number;readonly maximum:number;readonly ownedChunks:boolean;
 constructor(delimiter:number,maximum=1024*1024,ownedChunks=false){this.delimiter=delimiter;this.maximum=maximum;this.ownedChunks=ownedChunks;if(typeof ownedChunks!=='boolean'||!Number.isInteger(delimiter)||delimiter<0||delimiter>255||!Number.isSafeInteger(maximum)||maximum<1||maximum>64*1024**2)throw new RangeError('Invalid console frame limit');}
 get pending(){return this.#length;}
 push(chunk:Buffer):Buffer[]{const frames:Buffer[]=[];let start=0;for(;;){const end=chunk.indexOf(this.delimiter,start),part=chunk.subarray(start,end<0?chunk.length:end),size=this.#length+part.length;if(size>this.maximum)throw new RangeError('Console frame limit exceeded');if(end>=0&&this.#length===0){frames.push(this.ownedChunks?part:Buffer.from(part));start=end+1;if(start===chunk.length)return frames;continue;}if(size>this.#buffer.length){const next=Buffer.allocUnsafe(Math.min(this.maximum,Math.max(4096,size,this.#buffer.length*2)));this.#buffer.copy(next,0,0,this.#length);this.#buffer=next;}part.copy(this.#buffer,this.#length);this.#length=size;if(end<0)return frames;frames.push(Buffer.from(this.#buffer.subarray(0,this.#length)));this.#length=0;start=end+1;if(start===chunk.length)return frames;}}
 finish():Buffer|undefined{if(!this.#length)return;const result=Buffer.from(this.#buffer.subarray(0,this.#length));this.#length=0;return result;}
}
const utf8=new TextDecoder('utf-8',{fatal:true});
/** Validate syntax, then strip only out-of-string JSON whitespace. Never reserialize
 * parsed numbers: IDs and motion values retain their exact source lexemes. */
export function consoleRequest(line:Buffer):string|undefined{
 const text=utf8.decode(line).trim();if(!text||text.startsWith('#'))return;JSON.parse(text);
 if(!/[ \t\r\n]/.test(text))return text;
 let quoted=false,escaped=false,start=0,pieces:string[]|undefined;
 for(let i=0;i<text.length;i++){
  const c=text.charCodeAt(i);
  if(quoted){if(escaped)escaped=false;else if(c===92)escaped=true;else if(c===34)quoted=false;}
  else if(c===34)quoted=true;
  else if(c===32||c===9||c===13||c===10){pieces??=[];if(start<i)pieces.push(text.slice(start,i));start=i+1;}
 }
 if(!pieces)return text;if(start<text.length)pieces.push(text.slice(start));return pieces.join('');
}
// Cancellation stops waiting without destroying caller-owned output streams.
// Keep an error guard only until the outstanding write callback/error arrives.
const write=(stream:Writable,text:string|Buffer,signal:AbortSignal)=>new Promise<void>((resolve,reject)=>{
 if(signal.aborted){reject(signal.reason);return;}let settled=false;
 const finish=(error?:unknown)=>{if(settled)return;settled=true;signal.removeEventListener('abort',abort);if(error!==undefined)reject(error);else resolve();};
 const failed=(error:Error)=>finish(error),abort=()=>finish(signal.reason??new Error('Console write cancelled'));
 stream.once('error',failed);signal.addEventListener('abort',abort,{once:true});
 try{stream.write(text,error=>{if(!error)stream.removeListener('error',failed);finish(error??undefined);});}catch(error){stream.removeListener('error',failed);finish(error);}
});
export async function webhookConsole(path:string,input:Readable,output:Writable,errors:Writable,signal:AbortSignal,options:{connectTimeoutMs?:number;drainTimeoutMs?:number;frameBytes?:number}={}):Promise<void>{
 const connectMs=options.connectTimeoutMs??10000,drainMs=options.drainTimeoutMs??5000,limit=options.frameBytes??1024*1024;
 for(const value of [connectMs,drainMs])if(!Number.isInteger(value)||value<1||value>600000)throw new RangeError('Invalid console timeout');const keyboard=new ConsoleFrames(10,limit),frames=new ConsoleFrames(3,limit);signal.throwIfAborted();
 await write(errors,`Waiting for connect to ${path}\n`,signal);let socket:Socket|undefined;const until=performance.now()+connectMs;
 for(;;){signal.throwIfAborted();const candidate=createConnection({path,signal});try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>candidate.destroy(new Error('Console connection timed out')),Math.max(1,until-performance.now()));const cleanup=()=>{clearTimeout(timer);candidate.removeListener('connect',connected);candidate.removeListener('error',failed);};const connected=()=>{cleanup();resolve();},failed=(error:Error)=>{cleanup();reject(error);};candidate.once('connect',connected);candidate.once('error',failed);});socket=candidate;break;}catch(error){candidate.destroy();if((error as NodeJS.ErrnoException).code!=='ECONNREFUSED'||performance.now()>=until)throw error;await delay(Math.min(100,Math.max(1,until-performance.now())),undefined,{signal});}}
 const connection=socket,ioControl=new AbortController(),ioSignal=AbortSignal.any([signal,ioControl.signal]);let remoteEnded=false,drainTimer:ReturnType<typeof setTimeout>|undefined;const abort=()=>{connection.destroy(signal.reason instanceof Error?signal.reason:new Error('Console cancelled'));input.destroy();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 // Keep stream errors observed even between individual awaited writes.
 const socketError=(error:Error)=>{ioControl.abort(error);input.destroy(error);},inputError=(error:Error)=>{ioControl.abort(error);connection.destroy(error);},sinkError=(error:Error)=>{ioControl.abort(error);connection.destroy(error);input.destroy(error);};connection.on('error',socketError);input.on('error',inputError);output.on('error',sinkError);errors.on('error',sinkError);
 try{await write(errors,'Connection.\n',ioSignal);
  const send=async(line:Buffer)=>{let request:string|undefined;try{request=consoleRequest(line);}catch{await write(errors,'ERROR: Unable to parse line\n',ioSignal);return;}if(request===undefined)return;await write(output,`SEND: ${request}\n`,ioSignal);await write(connection,request+'\x03',ioSignal);};
  await Promise.all([(async()=>{try{for await(const chunk of input){for(const line of keyboard.push(Buffer.from(chunk)))await send(line);}const tail=keyboard.finish();if(tail)await send(tail);if(!remoteEnded){connection.end();drainTimer=setTimeout(()=>connection.destroy(new Error('Console response drain timed out')),drainMs);}}catch(error){if(!remoteEnded)throw error;}})(),(async()=>{for await(const chunk of connection){for(const frame of frames.push(Buffer.from(chunk))){const text=utf8.decode(frame);await write(output,`GOT: ${text}\n`,ioSignal);}}if(frames.pending)throw new Error('Socket closed with an incomplete frame');remoteEnded=true;input.destroy();ioControl.abort(new Error('Socket closed'));await write(errors,'Socket closed\n',signal);})()]);
 }finally{ioControl.abort(new Error('Console session closed'));clearTimeout(drainTimer);signal.removeEventListener('abort',abort);connection.destroy();input.destroy();/* Error listeners remain until stream close, covering asynchronous destroy. */const detach=()=>{connection.removeListener('error',socketError);input.removeListener('error',inputError);output.removeListener('error',sinkError);errors.removeListener('error',sinkError);};if(connection.closed&&input.closed)detach();else{let closed=0;const done=()=>{if(++closed===2)detach();};if(connection.closed)done();else connection.once('close',done);if(input.closed)done();else input.once('close',done);}}
}
