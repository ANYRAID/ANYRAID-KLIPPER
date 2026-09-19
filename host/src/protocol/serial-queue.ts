import {createRequire} from 'node:module';
import type {ReleaseEstimate} from '../timing/clock-sync.ts';
import type {ClockScheduler} from '../timing/clock-runtime.ts';
export interface SerialEvent {data:Uint8Array;sentTime:number;receiveTime:number;notifyId:bigint}
interface Native {
 create(fd:number):object;close(handle:object):void;
 send(handle:object,payload:Uint8Array,minClock:bigint,reqClock:bigint,notifyId:bigint,queue:number):void;
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
 #handle:object;#closed=false;#id=0n;
 constructor(fd:number){this.#handle=native.create(fd);}
 configure(baud:number,receiveWindow:number):void{native.configure(this.#handle,baud,receiveWindow);}
 setClockEstimate(estimate:ReleaseEstimate):void{native.estimate(this.#handle,estimate.frequency,estimate.sampleTime,estimate.clock);}
 send(payload:Uint8Array,minClock=0n,reqClock=0n,commandQueue=0):bigint{const id=this.#id+1n;native.send(this.#handle,payload,minClock,reqClock,id,commandQueue);this.#id=id;return id;}
 /** undefined=temporarily empty; null=receiver exited. Consume notifications
  * promptly: at most 4096 accepted messages may remain unconsumed. */
 pull():SerialEvent|undefined|null{return native.pull(this.#handle);}
 get stats():string{return native.stats(this.#handle);}
 close():void{if(!this.#closed){this.#closed=true;native.close(this.#handle);}}
 [Symbol.dispose]():void{this.close();}
}
