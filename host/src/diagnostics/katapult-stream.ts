import {setTimeout as delay} from 'node:timers/promises';
import {crc16} from '../protocol/codec.ts';
import {katapultFrame,katapultReply,KatapultRejectedError,type KatapultTransport} from './katapult.ts';
export interface KatapultByteIO {write(bytes:Buffer,offset:number):number;read(buffer:Buffer):number;close():void;}
/** Shared bounded framing/deadline engine for nonblocking UART and CAN bytes. */
export function katapultStream(io:KatapultByteIO,prime:boolean,signal:AbortSignal):KatapultTransport&{close():void}{
 let closed=false,busy=false,needsPrime=prime,stash:Buffer=Buffer.alloc(0);
 const stopped=new AbortController();
 const close=()=>{if(closed)return;closed=true;stopped.abort(new Error('Katapult transport closed'));signal.removeEventListener('abort',close);io.close();};
 signal.addEventListener('abort',close,{once:true});if(signal.aborted){close();signal.throwIfAborted();}
 return {close,async exchange(frame,timeoutMs,requestSignal){
  if(busy)throw new Error('Concurrent Katapult exchange');
  if(closed)throw new Error('Katapult transport closed');
  if(!Number.isFinite(timeoutMs)||timeoutMs<=0||timeoutMs>60000)throw new RangeError('Invalid Katapult timeout');
  const command=Buffer.from(frame);if(!command.equals(katapultFrame(command[2],command.subarray(4,-4))))throw new Error('Invalid Katapult request frame');
  busy=true;const active=AbortSignal.any([signal,requestSignal,stopped.signal]);let deadline=performance.now()+timeoutMs;
  const check=()=>{active.throwIfAborted();if(performance.now()>=deadline)throw new Error('Katapult transport exchange timed out');};
  const pause=async()=>{check();await delay(Math.min(1,Math.max(0,deadline-performance.now())),undefined,{signal:active});check();};
  const write=async(bytes:Buffer)=>{let offset=0;while(offset<bytes.length){check();let count=0;try{count=io.write(bytes,offset);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}if(!Number.isInteger(count)||count<0||count>bytes.length-offset)throw new Error('Invalid Katapult write progress');offset+=count;if(count===0)await pause();}};
  const readFrame=async()=>{
   let skipped=0;const buffer=Buffer.allocUnsafe(2048);
   while(true){
    check();while(stash.length>=2&&(stash[0]!==1||stash[1]!==0x88)){stash=stash.subarray(1);if(++skipped>4096)throw new Error('Katapult response noise limit exceeded');}
    if(stash.length>=4){const length=stash[3]*4+8;if(stash.length>=length){const reply=Buffer.from(stash.subarray(0,length));stash=stash.subarray(length);if(reply.at(-2)!==0x99||reply.at(-1)!==3||reply.readUInt16LE(length-4)!==(crc16(reply.subarray(2,-4))&0xffff))throw new Error('Invalid Katapult transport CRC or trailer');return reply;}}
    let count=0;try{count=io.read(buffer);}catch(error){if((error as NodeJS.ErrnoException).code!=='EAGAIN')throw error;}
    if(count){stash=Buffer.concat([stash,buffer.subarray(0,count)]);if(stash.length>4096)throw new Error('Katapult transport receive limit exceeded');}else await pause();
   }
  };
  try{
   for(let attempt=0;attempt<5;attempt++){
   deadline=performance.now()+timeoutMs;
   check();if(stash.length)throw new Error('Unexpected trailing Katapult response');
   const primed=needsPrime;needsPrime=false;
   if(primed)await write(katapultFrame(0x90));await write(command);
   if(primed){const response=await readFrame();if(![0xf1,0xf2].includes(response[2])||response[3]!==0&&(response.length<12||response.readUInt32LE(4)!==0x90))throw new Error('Invalid Katapult priming response');}
   const response=await readFrame();
   try{katapultReply(command[2],response);}catch(error){
    // Only parser NACKs on non-writing commands have a bounded retry path.
    // Busy/error responses can follow Flash activity; never replay those.
    if(!(error instanceof KatapultRejectedError)||error.acknowledgement!==0xf1||![0x11,0x14,0x16].includes(command[2])||attempt===4||stash.length)throw error;
    await delay(500,undefined,{signal:active});continue;
   }
   check();return response;
   }
   throw new Error('Katapult retry limit exceeded');
  }catch(error){const failure=active.aborted?active.reason:error;try{close();}catch{/* Preserve the operation failure. */}throw failure;}finally{busy=false;}
 }};
}
