import {Socket} from 'node:net';
import {closeSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {ReleaseEstimate} from '../timing/clock-sync.ts';
import type {ClockScheduler} from '../timing/clock-runtime.ts';
export interface SerialEvent {data:Uint8Array;sentTime:number;receiveTime:number;notifyId:bigint}
export interface SerialPacket {data:Uint8Array;min:bigint;req:bigint}
interface Native {
 wakeFd(handle:object):number;create(fd:number):object;close(handle:object):void;
 send(handle:object,payload:Uint8Array,minClock:bigint,reqClock:bigint,notifyId:bigint,queue:number):void;
 sendBatch(handle:object,packed:Uint8Array,firstId:bigint,queue:number,deadline:number):void;
 pull(handle:object):SerialEvent|undefined|null;
 configure(handle:object,frequency:number,window:number):void;
 estimate(handle:object,frequency:number,time:number,clock:bigint):void;
 now():number;stats(handle:object):string;
}
const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
/** CLOCK_MONOTONIC_RAW shared with serialqueue timestamps. performance.now()
 * has a different origin and must not be mixed with these MCU samples. */
export const serialClock:ClockScheduler={now:()=>native.now(),schedule(callback,seconds){const timer=setTimeout(callback,seconds*1000);return ()=>clearTimeout(timer);}};
/** Linux UART/stream transport kernel. Owns a duplicate fd; original owner must
 * stop reading/writing and remains responsible for closing its own descriptor.
 * drain is nonblocking. close cancels host traffic, NOT already queued MCU moves. */
export class NativeSerialQueue {
 #handle:object;#closed=false;#id=0n;#wake:Socket|undefined;
 constructor(fd:number){this.#handle=native.create(fd);}
 /** Zero leaves the corresponding native setting unchanged. */
 configure(baud:number,receiveWindow:number):void{native.configure(this.#handle,baud,receiveWindow);}
 setClockEstimate(estimate:ReleaseEstimate):void{native.estimate(this.#handle,estimate.frequency,estimate.sampleTime,estimate.clock);}
 send(payload:Uint8Array,minClock=0n,reqClock=0n,commandQueue=0):bigint{const id=this.#id+1n;native.send(this.#handle,payload,minClock,reqClock,id,commandQueue);this.#id=id;return id;}
 /** One native queue splice, consecutive notification IDs. All validation and
  * payload copies finish before acceptance. Returns the first accepted ID.
  * deadline uses serialClock's seconds; zero disables the acceptance deadline. */
 sendBatch(packets:readonly SerialPacket[],commandQueue=0,deadline=0):bigint{
  if(!Array.isArray(packets))throw new RangeError('Invalid serial batch');const count=packets.length;
  if(!Number.isInteger(count)||count<1||count>4096)throw new RangeError('Invalid serial batch');
  const packed=Buffer.alloc(count*76);
  for(let i=0;i<count;i++){const {data,min,req}=packets[i];if(!(data instanceof Uint8Array)||!(data.buffer instanceof ArrayBuffer)||data.length<1||data.length>59||typeof min!=='bigint'||typeof req!=='bigint')throw new RangeError('Invalid serial batch packet');const offset=i*76;packed.writeBigUInt64LE(min,offset);packed.writeBigUInt64LE(req,offset+8);packed[offset+16]=data.length;packed.set(data,offset+17);}
  const first=this.#id+1n;native.sendBatch(this.#handle,packed,first,commandQueue,deadline);this.#id+=BigInt(count);return first;
 }
 /** undefined=temporarily empty; null=receiver exited. Consume notifications
  * promptly: at most 4096 accepted messages may remain unconsumed. */
 pull():SerialEvent|undefined|null{return native.pull(this.#handle);}
 get stats():string{return native.stats(this.#handle);}
 /** One listener per queue. Native wake bytes only signal availability; pull
  * remains authoritative. The callback must drain or schedule a bounded drain. */
 watch(onReady:()=>void,onError:(error:unknown)=>void):void{
  if(this.#wake)throw new Error('Serial wake listener already attached');
  const fd=native.wakeFd(this.#handle);let socket:Socket;
  try{socket=new Socket({fd,readable:true,writable:false});}catch(error){closeSync(fd);this.close();throw error;}
  this.#wake=socket;
  const fail=(error:unknown)=>{if(this.#closed)return;this.close();onError(error);};
  socket.on('data',()=>{if(this.#closed)return;try{onReady();}catch(error){fail(error);}});
  socket.on('error',fail);socket.on('end',()=>fail(new Error('Serial wake channel ended')));
  socket.on('close',()=>{if(!this.#closed)fail(new Error('Serial wake channel closed'));});
 }
 close():void{if(!this.#closed){this.#closed=true;try{native.close(this.#handle);}finally{this.#wake?.destroy();this.#wake=undefined;}}}
 [Symbol.dispose]():void{this.close();}
}
