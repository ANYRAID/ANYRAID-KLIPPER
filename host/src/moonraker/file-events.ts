import {createRequire} from 'node:module';
import {endianness} from 'node:os';
import type {FileHandle} from 'node:fs/promises';
export const fileEventMask=Object.freeze({modify:2,closeWrite:8,open:32,movedFrom:64,movedTo:128,create:256,delete:512,deleteSelf:1024,moveSelf:2048,unmount:8192,overflow:16384,ignored:32768,directory:0x40000000});
export interface FileEvent {readonly watch:number;readonly mask:number;readonly cookie:number;readonly name:string;}
interface Native {create(callback:(bytes:Buffer|null,error:string|null)=>void):object;add(owner:object,fd:number):number;remove(owner:object,watch:number):void;close(owner:object):void;}
let native:Native|undefined;
const filenameDecoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
/** Linux ABI decoding. Input is a bounded read from the native owner, never an
 * HTTP payload. Keep parsing separate for malformed/overflow controls. */
export function parseFileEvents(bytes:Buffer):readonly FileEvent[]{
 if(!Buffer.isBuffer(bytes)||bytes.length>65536)throw new Error('Invalid directory event chunk');
 const result:FileEvent[]=[],view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),little=endianness()==='LE';
 for(let at=0;at<bytes.length;){
  if(at+16>bytes.length)throw new Error('Truncated directory event header');const watch=view.getInt32(at,little),mask=view.getUint32(at+4,little),cookie=view.getUint32(at+8,little),length=view.getUint32(at+12,little);
  if(length>256||at+16+length>bytes.length)throw new Error('Invalid directory event name length');
  const data=bytes.subarray(at+16,at+16+length),zero=data.indexOf(0);if(length&&zero<0||zero>=0&&data.subarray(zero).some(byte=>byte!==0))throw new Error('Invalid directory event name terminator');
  const name=filenameDecoder.decode(zero<0?data:data.subarray(0,zero));if(/[\/\0]/u.test(name))throw new Error('Invalid directory event name');
  if(mask&fileEventMask.overflow)throw new Error('Directory event queue overflow');
  if(watch<0)throw new Error('Invalid directory event watch');result.push(Object.freeze({watch,mask,cookie,name}));at+=16+length;
 }
 return Object.freeze(result);
}
/** Explicit close-write events on borrowed, already no-follow directory FDs.
 * The poll is unreferenced, capacity bounded and close joins native retirement. */
export class FileEvents {
 readonly #native:Native;readonly #owner:object;readonly #watches=new Set<number>();readonly #done=Promise.withResolvers<void>();readonly #events:(events:readonly FileEvent[])=>void;readonly #fault:(cause:unknown)=>void;
 #closing=false;#closed=false;#error:unknown;
 constructor(events:(events:readonly FileEvent[])=>void,fault:(cause:unknown)=>void){
  if(typeof events!=='function'||typeof fault!=='function')throw new TypeError('Directory event handlers required');
  this.#events=events;this.#fault=fault;this.#native=native??=createRequire(import.meta.url)(process.env.ANYRAID_FILE_EVENTS_ADDON??'../../build/file-events.node') as Native;
  this.#owner=this.#native.create((bytes,error)=>{
   if(bytes===null&&error===null){this.#closed=true;this.#watches.clear();this.#done.resolve();return;}
   if(this.#closing)return;
   try{if(error!==null)throw new Error(error);this.#events(parseFileEvents(bytes!));}catch(cause){this.#fail(cause);}
  });
 }
 get status(){return {closing:this.#closing,closed:this.#closed,watches:this.#watches.size,fault:this.#error};}
 #fail(cause:unknown){if(this.#error!==undefined)return;this.#error=cause;try{this.#fault(cause);}catch(error){this.#error=new AggregateError([cause,error],'Directory event fault reporting failed');}void this.close();}
 add(directory:FileHandle):number{
  if(this.#closing||this.#closed)throw new Error('Directory events closed');if(this.#watches.size>=1024)throw new Error('Directory watch capacity exceeded');
  if(!directory||!Number.isSafeInteger(directory.fd)||directory.fd<0)throw new TypeError('Open directory descriptor required');const watch=this.#native.add(this.#owner,directory.fd);this.#watches.add(watch);return watch;
 }
 remove(watch:number):void{if(this.#closing||!this.#watches.delete(watch))return;this.#native.remove(this.#owner,watch);}
 close():Promise<void>{if(!this.#closing){this.#closing=true;this.#native.close(this.#owner);}return this.#done.promise;}
}
