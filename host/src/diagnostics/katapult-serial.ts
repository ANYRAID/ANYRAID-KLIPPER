import {closeSync,readSync,writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {crc16} from '../protocol/codec.ts';
import {katapultFrame,katapultReply,type KatapultTransport} from './katapult.ts';
interface Native {openUART(path:string,baud:number,rts:boolean):number;}
export function katapultNeedsPriming(product:string):boolean {return product.startsWith('stm32')&&!['f2','f4','h7'].includes(product.slice(5,7));}
export interface KatapultSerialOptions {baud?:number;prime?:boolean;}
/** A single-owner raw UART connection, already in the Katapult bootloader.
 * Does not reboot, reconnect or replay writes. Close on every failure. */
export function openKatapultSerial(path:string,options:KatapultSerialOptions={},signal:AbortSignal):KatapultTransport&{close():void} {
 signal.throwIfAborted();const {baud=250000,prime=false}=options;
 if(typeof prime!=='boolean'||!Number.isInteger(baud)||baud<1||baud>4000000)throw new TypeError('Invalid Katapult serial options');
 const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
 let fd=native.openUART(path,baud,true),busy=false,needsPrime=prime,stash:Buffer=Buffer.alloc(0);
 const stopped=new AbortController();
 const close=()=>{if(fd<0)return;const owned=fd;fd=-1;stopped.abort(new Error('Katapult serial closed'));signal.removeEventListener('abort',close);closeSync(owned);};
 signal.addEventListener('abort',close,{once:true});if(signal.aborted){close();signal.throwIfAborted();}
 return {close,async exchange(frame,timeoutMs,requestSignal){
  if(busy)throw new Error('Concurrent Katapult exchange');
  if(fd<0)throw new Error('Katapult serial closed');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>60000)throw new RangeError('Invalid Katapult timeout');
  const command=Buffer.from(frame);if(!command.equals(katapultFrame(command[2],command.subarray(4,-4))))throw new Error('Invalid Katapult request frame');
  busy=true;const active=AbortSignal.any([signal,requestSignal,stopped.signal]),deadline=performance.now()+timeoutMs;
  const check=()=>{active.throwIfAborted();if(performance.now()>=deadline)throw new Error('Katapult serial exchange timed out');};
  const pause=async()=>{check();await delay(Math.min(1,Math.max(0,deadline-performance.now())),undefined,{signal:active});check();};
  const write=async(bytes:Buffer)=>{let offset=0;while(offset<bytes.length){check();try{offset+=writeSync(fd,bytes,offset);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}if(offset<bytes.length)await pause();}};
  const readFrame=async()=>{
   let skipped=0;const buffer=Buffer.allocUnsafe(2048);
   while(true){
    check();while(stash.length>=2&&(stash[0]!==1||stash[1]!==0x88)){stash=stash.subarray(1);if(++skipped>4096)throw new Error('Katapult response noise limit exceeded');}
    if(stash.length>=4){const length=stash[3]*4+8;if(stash.length>=length){const reply=Buffer.from(stash.subarray(0,length));stash=stash.subarray(length);if(reply.at(-2)!==0x99||reply.at(-1)!==3||reply.readUInt16LE(length-4)!==(crc16(reply.subarray(2,-4))&0xffff))throw new Error('Invalid Katapult serial CRC or trailer');return reply;}}
    let count=0;try{count=readSync(fd,buffer);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}
    if(count){stash=Buffer.concat([stash,buffer.subarray(0,count)]);if(stash.length>4096)throw new Error('Katapult serial receive limit exceeded');}else await pause();
   }
  };
  try{
   check();if(stash.length)throw new Error('Unexpected trailing Katapult response');
   const primed=needsPrime;needsPrime=false;
   if(primed)await write(katapultFrame(0x90));await write(command);
   if(primed){const response=await readFrame();if(![0xf1,0xf2].includes(response[2])||response[3]!==0&&(response.length<12||response.readUInt32LE(4)!==0x90))throw new Error('Invalid Katapult priming response');}
   const response=await readFrame();katapultReply(command[2],response);check();return response;
  }catch(error){const failure=active.aborted?active.reason:error;try{close();}catch{/* Preserve the operation failure. */}throw failure;}finally{busy=false;}
 }};
}
