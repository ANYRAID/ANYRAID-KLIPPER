import {closeSync,readSync,writeSync} from 'node:fs';
import {createRequire} from 'node:module';
import type {KatapultTransport} from './katapult.ts';
import {katapultStream} from './katapult-stream.ts';
interface Native {openUART(path:string,baud:number,rts:boolean):number;}
export function katapultNeedsPriming(product:string):boolean {return product.startsWith('stm32')&&!['f2','f4','h7'].includes(product.slice(5,7));}
export interface KatapultSerialOptions {baud?:number;prime?:boolean;}
/** A single-owner raw UART connection, already in the Katapult bootloader.
 * Does not reboot, reconnect or replay writes. Close on every failure. */
export function openKatapultSerial(path:string,options:KatapultSerialOptions={},signal:AbortSignal):KatapultTransport&{close():void} {
 signal.throwIfAborted();const {baud=250000,prime=false}=options;
 if(typeof prime!=='boolean'||!Number.isInteger(baud)||baud<1||baud>4000000)throw new TypeError('Invalid Katapult serial options');
 const native=createRequire(import.meta.url)(process.env.ANYRAID_SERIALQUEUE_ADDON??'../../build/serialqueue.node') as Native;
 const fd=native.openUART(path,baud,true);
 return katapultStream({write:(bytes,offset)=>writeSync(fd,bytes,offset),read:buffer=>readSync(fd,buffer),close:()=>closeSync(fd)},prime,signal);
}
