// Native SD card lifecycle, replacing SDCardSDIO in spi_flash.py (GPL-3.0-or-later).
// Status fields: SD physical layer / Linux include/linux/mmc/mmc.h.
import {setTimeout as delay} from 'node:timers/promises';
import {sdCRC7,sdCapacity,type SDCardInfo} from './sd-card-spi.ts';
import type {SDIOTransport} from './sdio-mcu.ts';
function word(bytes:Uint8Array){if(bytes.length!==4)throw new Error('Invalid SDIO short response');return Buffer.from(bytes).readUInt32BE();}
export function sdNativeStatus(bytes:Uint8Array){const value=word(bytes);if(value&0xfff9a008)throw new Error('SD card status error 0x'+value.toString(16));return {state:(value>>>9)&15,ready:!!(value&256),app:!!(value&32)};}
function register(data:Uint8Array){if(data.length!==16||(sdCRC7(data.subarray(0,15))&254)!==(data[15]&254))throw new Error('Invalid SDIO register CRC');const normalized=data.slice();normalized[15]|=1;return normalized;}
const ascii=(bytes:Uint8Array)=>Array.from(bytes).filter(b=>b<128).map(b=>String.fromCharCode(b)).join('');
export class SDCardSDIO {
 readonly #io:SDIOTransport;#tail:Promise<unknown>=Promise.resolve();#pending=0;#info:SDCardInfo|undefined;#rca=0;
 constructor(io:SDIOTransport){this.#io=io;}
 get info(){return this.#info?{...this.#info}:undefined;}
 #operation<T>(signal:AbortSignal,work:(s:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.#pending>=8)return Promise.reject(new Error('SDIO card queue full'));this.#pending++;
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]),task=this.#tail.then(async()=>{bounded.throwIfAborted();try{const value=await work(bounded);bounded.throwIfAborted();return value;}catch(error){this.#info=undefined;this.#rca=0;throw error;}});
  this.#tail=task.catch(()=>{});return task.finally(()=>{this.#pending--;});
 }
 async #command(cmd:number,arg:number,wait:0|1|2,s:AbortSignal,allowed:readonly number[]=[]){
  s.throwIfAborted();const r=await this.#io.command(cmd,arg,wait,s);s.throwIfAborted();if(r.error!==0&&!allowed.includes(r.error))throw new Error('SDIO command '+cmd+' failed: '+r.error);
  if(!(r.response instanceof Uint8Array)||r.response.length!==(wait===2?16:wait===1?4:0))throw new Error('Invalid SDIO command response');return r.response;
 }
 async #ready(s:AbortSignal){for(let attempt=0;attempt<100;attempt++){const status=sdNativeStatus(await this.#command(13,this.#rca*65536,1,s));if(status.ready&&status.state===4)return;if(status.state!==4&&status.state!==7)throw new Error('SD card is not in transfer/programming state');await delay(10,undefined,{signal:s});}throw new Error('SD card programming timeout');}
 initialize(signal:AbortSignal):Promise<SDCardInfo>{return this.#operation(signal,async s=>{
  if(this.#info)return {...this.#info};this.#rca=0;await this.#io.speed(400000,s);await this.#command(0,0,0,s);
  const cond=await this.#io.command(8,0x10a,1,s);s.throwIfAborted();let version:1|2;
  if(cond.error===3)version=1;else{if(cond.error!==0||word(cond.response)!==0x10a)throw new Error('Invalid SD interface condition');version=2;}
  let ocr=0;
  for(let attempt=0;attempt<15;attempt++){
   if(!sdNativeStatus(await this.#command(55,0,1,s)).app)throw new Error('SD APP_CMD not accepted');
   // No 1.8 V negotiation: this owner has no voltage-switch implementation.
   ocr=word(await this.#command(41,(version===2?0x40000000:0)|0x00300000,1,s,[4,5]));
   if(ocr&0x80000000)break;await delay(100,undefined,{signal:s});
  }
  if(!(ocr&0x80000000)||!(ocr&0x00300000))throw new Error('SD card not ready at supported voltage');
  const highCapacity=version===2&&!!(ocr&0x40000000),cid=register(await this.#command(2,0,2,s));
  const address=word(await this.#command(3,0,1,s));if(address&0xe000)throw new Error('SD relative address rejected');this.#rca=address>>>16;if(!this.#rca)throw new Error('SD relative address is zero');
  const csd=register(await this.#command(9,this.#rca*65536,2,s)),capacity=sdCapacity(csd);if(highCapacity!==((csd[0]>>>6)===1))throw new Error('SD OCR and CSD addressing disagree');
  sdNativeStatus(await this.#command(7,this.#rca*65536,1,s));await this.#ready(s);
  await this.#io.speed(1000000,s);sdNativeStatus(await this.#command(16,512,1,s));
  const info:SDCardInfo={version,highCapacity,...capacity,manufacturerId:cid[0],oem:ascii(cid.subarray(1,3)),product:ascii(cid.subarray(3,8)),revision:(cid[8]>>>4)+'.'+(cid[8]&15),serial:Buffer.from(cid.subarray(9,13)).toString('hex').toUpperCase(),manufacturingDate:(cid[14]&15)+'/'+(2000+((cid[13]&15)<<4)+(cid[14]>>>4))};
  s.throwIfAborted();this.#info=info;return {...info};
 });}
 #address(sector:number,write=false){const info=this.#info;if(!info)throw new Error('SDIO card not initialized');if(!Number.isInteger(sector)||sector<0||sector>=info.sectors)throw new RangeError('SD sector out of range');if(write&&info.writeProtected)throw new Error('SD card is write protected');const address=info.highCapacity?sector:sector*512;if(address>0xffffffff)throw new RangeError('SD address overflow');return address;}
 readSector(sector:number,signal:AbortSignal){return this.#operation(signal,async s=>{const bytes=await this.#io.readSector(this.#address(sector),s);s.throwIfAborted();if(!(bytes instanceof Uint8Array)||bytes.length!==512)throw new Error('Incomplete SD sector');return bytes.slice();});}
 writeSector(sector:number,data:Uint8Array,signal:AbortSignal){
  if(!(data instanceof Uint8Array)||data.length>512)return Promise.reject(new RangeError('Invalid SD sector payload'));const bytes=new Uint8Array(512);bytes.set(data);
  return this.#operation(signal,async s=>{const address=this.#address(sector,true);await this.#io.writeSector(address,bytes,s);s.throwIfAborted();await this.#ready(s);});
 }
 deinitialize(signal:AbortSignal){return this.#operation(signal,async s=>{const active=this.#info;this.#info=undefined;this.#rca=0;if(active){await this.#command(0,0,0,s);await this.#io.speed(400000,s);}});}
}
