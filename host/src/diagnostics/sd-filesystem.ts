import {FatFS} from './fatfs.ts';
import type {SDCardInfo} from './sd-card-spi.ts';
export interface SDCardDevice {
 readonly info:SDCardInfo|undefined;
 initialize(signal:AbortSignal):Promise<SDCardInfo>;
 readSector(sector:number,signal:AbortSignal):Promise<Uint8Array>;
 writeSector(sector:number,data:Uint8Array,signal:AbortSignal):Promise<void>;
 deinitialize(signal:AbortSignal):Promise<void>;
}
const owners=new WeakSet<SDCardDevice>();
/** Exclusive filesystem lease. Card writes complete only after their busy/status
 * checks; thus FatFs CTRL_SYNC has no additional write queue to flush. */
export class SDFileSystem {
 readonly #card:SDCardDevice;readonly #fs:FatFS;#closing:Promise<void>|undefined;
 private constructor(card:SDCardDevice,fs:FatFS){this.#card=card;this.#fs=fs;}
 static async open(card:SDCardDevice,signal:AbortSignal,helper?:string):Promise<SDFileSystem>{
  signal.throwIfAborted();if(owners.has(card))throw new Error('SD card already has a filesystem owner');owners.add(card);
  let filesystem:FatFS|undefined;
  try{
   const info=await card.initialize(signal);signal.throwIfAborted();
   filesystem=await FatFS.mount({sectors:info.sectors,writeProtected:info.writeProtected,readSector:card.readSector.bind(card),writeSector:card.writeSector.bind(card),async sync(s){s.throwIfAborted();if(!card.info)throw new Error('SD card lost initialized state');}},signal,helper);
   signal.throwIfAborted();return new SDFileSystem(card,filesystem);
  }catch(error){const errors:unknown[]=[error];try{await filesystem?.close();}catch(cleanup){errors.push(cleanup);}try{await card.deinitialize(AbortSignal.timeout(5000));}catch(cleanup){errors.push(cleanup);}finally{owners.delete(card);}if(errors.length>1)throw new AggregateError(errors,'SD filesystem startup and card cleanup failed',{cause:error});throw error;}
 }
 #active(){if(this.#closing)throw new Error('SD filesystem is closing');}
 readFile(path:string,signal:AbortSignal){this.#active();return this.#fs.readFile(path,signal);}
 writeFile(path:string,data:Uint8Array,signal:AbortSignal){this.#active();return this.#fs.writeFile(path,data,signal);}
 stat(path:string,signal:AbortSignal){this.#active();return this.#fs.stat(path,signal);}
 remove(path:string,signal:AbortSignal){this.#active();return this.#fs.remove(path,signal);}
 close():Promise<void>{
  if(this.#closing)return this.#closing;
  this.#closing=(async()=>{const errors:unknown[]=[];try{await this.#fs.close();}catch(error){errors.push(error);}try{await this.#card.deinitialize(AbortSignal.timeout(5000));}catch(error){errors.push(error);}finally{owners.delete(this.#card);}if(errors.length)throw new AggregateError(errors,'SD filesystem cleanup failed');})();return this.#closing;
 }
}
