import {createRequire} from 'node:module';
const native=createRequire(import.meta.url)(process.env.ANYRAID_SEALED_FILE_ADDON??'../../build/sealed-file.node') as {pageSize():number};
const pageBytes=native.pageSize();
/** Owner-local quota for kernel snapshot content. Counts page-rounded bytes
 * and live reservations; fixed read/copy buffers and kernel metadata are extra. */
export class PrintSnapshotBudget {
 #maxBytes:number;#maxSnapshots:number;#bytes=0;#count=0;
 constructor(options:{maxBytes?:number;maxSnapshots?:number}={}){
  this.#maxBytes=options.maxBytes??128*1024**2;this.#maxSnapshots=options.maxSnapshots??2;
  if(!Number.isSafeInteger(this.#maxBytes)||this.#maxBytes<1||this.#maxBytes>16*1024**3||!Number.isSafeInteger(this.#maxSnapshots)||this.#maxSnapshots<1||this.#maxSnapshots>64)throw new RangeError('Invalid print snapshot quota');
 }
 get status(){return {reservedBytes:this.#bytes,reservations:this.#count,maxBytes:this.#maxBytes,maxSnapshots:this.#maxSnapshots,pageBytes};}
 reserve(size:number):Readonly<{bytes:number;release:()=>void}>{
  if(!Number.isSafeInteger(size)||size<0||size>1024**3)throw new RangeError('Invalid snapshot reservation size');
  const bytes=Math.ceil(size/pageBytes)*pageBytes;
  if(this.#count>=this.#maxSnapshots||bytes>this.#maxBytes-this.#bytes)throw new Error('Print snapshot quota exceeded');
  this.#count++;this.#bytes+=bytes;let active=true;
  return Object.freeze({bytes,release:()=>{if(!active)return;active=false;this.#count--;this.#bytes-=bytes;}});
 }
}
/** Shared by request handlers in this JS isolate; other workers need a central owner. */
export const defaultPrintSnapshotBudget=new PrintSnapshotBudget();
