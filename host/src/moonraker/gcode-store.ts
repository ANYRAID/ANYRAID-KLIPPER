// G-code portion of Moonraker data_store.py. GPL-3.0-or-later.
// Original Copyright (C) 2020 Eric Callahan.
import {pythonStrip,metadataInteger} from './metadata-values.ts';
import {ApiError,type Json} from './rpc.ts';
import type {EndpointRegistry} from './endpoints.ts';
export interface GcodeRecord {message:string;time:number;type:'command'|'response'}
export class GcodeStore {
 readonly #entries:(Readonly<GcodeRecord>|undefined)[];readonly #maxBytes:number;readonly #clock:()=>number;
 #head=0;#count=0;#bytes=0;#discarded=0;
 constructor(capacity=1000,maxBytes=8*1024*1024,clock=()=>Date.now()/1000){if(!Number.isSafeInteger(capacity)||capacity<0||capacity>100000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024||typeof clock!=='function')throw new RangeError('Invalid G-code store limits');this.#entries=new Array(capacity);this.#maxBytes=maxBytes;this.#clock=clock;}
 get status(){return {records:this.#count,payloadBytes:this.#bytes,discarded:this.#discarded};}
 #drop():void{const value=this.#entries[this.#head]!;this.#bytes-=Buffer.byteLength(value.message);this.#entries[this.#head]=undefined;this.#head=(this.#head+1)%this.#entries.length;this.#count--;this.#discarded++;}
 record(message:string,type:GcodeRecord['type']):void{
  if(typeof message!=='string'||!['command','response'].includes(type))throw new TypeError('Invalid G-code record');
  if(type==='command'&&!pythonStrip(message))return;
  const bytes=Buffer.byteLength(message);if(!this.#entries.length||bytes>this.#maxBytes){this.#discarded++;return;}const time=this.#clock();if(!Number.isFinite(time))throw new RangeError('Invalid G-code timestamp');
  while(this.#count&&(this.#count===this.#entries.length||this.#bytes+bytes>this.#maxBytes))this.#drop();
  this.#entries[(this.#head+this.#count)%this.#entries.length]=Object.freeze({message,time,type});this.#count++;this.#bytes+=bytes;
 }
 snapshot(count?:number):{gcode_store:GcodeRecord[]}{
  if(count!==undefined&&!Number.isSafeInteger(count))throw new RangeError('Invalid G-code history count');
  const start=count===undefined||count===0?0:count>0?Math.max(0,this.#count-count):Math.min(this.#count,-count),result:GcodeRecord[]=[];
  for(let i=start;i<this.#count;i++)result.push({...this.#entries[(this.#head+i)%this.#entries.length]!});return {gcode_store:result};
 }
}
export function gcodeStoreCount(value:Json|undefined):number|undefined{
 if(value===undefined)return undefined;let count:number|undefined;
 if(typeof value==='boolean')count=Number(value);else if(typeof value==='number'&&Number.isFinite(value))count=Math.max(-Number.MAX_SAFE_INTEGER,Math.min(Number.MAX_SAFE_INTEGER,Math.trunc(value)));
 // Python int does not accept the four C0 separators accepted by str.strip.
 else if(typeof value==='string'&&value.length<=1024&&!/[\x1c-\x1f]/.test(value)){try{count=metadataInteger(value);}catch(error){if(error instanceof RangeError&&error.message==='Unsafe metadata integer')count=pythonStrip(value).startsWith('-')?-Number.MAX_SAFE_INTEGER:Number.MAX_SAFE_INTEGER;else throw error;}}
 if(count===undefined||!Number.isSafeInteger(count))throw new ApiError(400,'Unable to parse argument: count');return count;
}
export function registerGcodeStore(registry:EndpointRegistry,store:GcodeStore):()=>void{return registry.register({endpoint:'/server/gcode_store',methods:['GET']},params=>store.snapshot(gcodeStoreCount(params.count)) as unknown as Json);}
