// SD SPI protocol port from scripts/spi_flash/spi_flash.py.
// Eric Callahan (2021), GPL-3.0-or-later. No filesystem or MCU ownership here.
import {setTimeout as delay} from 'node:timers/promises';
export interface SDCardSPITransport {
 send(data:Uint8Array,signal:AbortSignal):Promise<void>;
 transfer(data:Uint8Array,signal:AbortSignal):Promise<Uint8Array>;
}
export function sdCRC7(data:Uint8Array):number{
 let crc=0;for(const byte of data){crc^=byte;for(let i=0;i<8;i++)crc=((crc<<1)^((crc&128)?0x112:0))&255;}return crc|1;
}
const crcTable=Uint16Array.from({length:256},(_,i)=>{let crc=i<<8;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&0x8000)?0x1021:0))&0xffff;return crc;});
export function sdCRC16(data:Uint8Array):number{let crc=0;for(const byte of data)crc=((crc<<8)^crcTable[(crc>>>8)^byte])&0xffff;return crc;}
export function sdCommand(command:number,argument:number):Uint8Array{
 if(!Number.isInteger(command)||command<0||command>63||!Number.isInteger(argument)||argument<0||argument>0xffffffff)throw new RangeError('Invalid SD command');
 const bytes=Buffer.alloc(6);bytes[0]=command|0x40;bytes.writeUInt32BE(argument,1);bytes[5]=sdCRC7(bytes.subarray(0,5));return bytes;
}
export interface SDCardInfo {version:1|2;highCapacity:boolean;writeProtected:boolean;sectors:number;manufacturerId:number;oem:string;product:string;revision:string;serial:string;manufacturingDate:string;}
function register(bytes:Uint8Array){if(bytes.length!==16||sdCRC7(bytes.subarray(0,15))!==bytes[15])throw new Error('Invalid SD register CRC');}
export function sdCapacity(csd:Uint8Array):{sectors:number;writeProtected:boolean}{
 register(csd);const type=csd[0]>>>6;
 const bytes=type===0?(((csd[6]&3)*1024+csd[7]*4+(csd[8]>>>6))+1)*2**(((csd[9]&3)*2+(csd[10]>>>7))+2)*2**(csd[5]&15):type===1?((csd[7]&63)*65536+csd[8]*256+csd[9]+1)*524288:NaN;
 const sectors=bytes/512;if(!Number.isSafeInteger(sectors)||sectors<1||sectors>0x100000000)throw new Error('Unsupported SD capacity');
 return {sectors,writeProtected:(csd[14]&0x30)!==0};
}
const ascii=(data:Uint8Array)=>Array.from(data).filter(b=>b<128).map(b=>String.fromCharCode(b)).join('');
/** One transaction at a time. IO must honor cancellation; each operation has a
 * 30-second deadline. An ambiguous IO failure invalidates the initialized state
 * so subsequent reads/writes cannot continue an uncertain card transaction. */
export class SDCardSPI {
 readonly #io:SDCardSPITransport;#tail:Promise<unknown>=Promise.resolve();#info:SDCardInfo|undefined;#pending=0;
 constructor(io:SDCardSPITransport){this.#io=io;}
 get info():SDCardInfo|undefined{return this.#info?{...this.#info}:undefined;}
 #operation<T>(signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  if(this.#pending>=8)return Promise.reject(new Error('SD transaction queue full'));
  const bounded=AbortSignal.any([signal,AbortSignal.timeout(30000)]);this.#pending++;
  const task=this.#tail.then(async()=>{bounded.throwIfAborted();try{return await work(bounded);}catch(error){this.#info=undefined;throw error;}});
  this.#tail=task.catch(()=>{});return task.finally(()=>{this.#pending--;});
 }
 async #send(data:Uint8Array,signal:AbortSignal){signal.throwIfAborted();await this.#io.send(data,signal);signal.throwIfAborted();}
 async #transfer(size:number,signal:AbortSignal){signal.throwIfAborted();const data=await this.#io.transfer(new Uint8Array(size).fill(255),signal);signal.throwIfAborted();if(!(data instanceof Uint8Array)||data.length!==size)throw new Error('Truncated SD SPI response');return data;}
 async #command(command:number,arg:number,signal:AbortSignal){await this.#send(sdCommand(command,arg),signal);const response=await this.#transfer(8,signal);let start=0;while(start<response.length&&response[start]===255)start++;return response.subarray(start);}
 async #check(expected:number,command:number,arg:number,signal:AbortSignal,tries=15,app=false){
  for(let i=0;i<tries;i++){
   if(app){const prefix=await this.#command(55,0,signal);if(!prefix.length||prefix[0]>1)throw new Error('SD APP_CMD rejected');}
   const r=await this.#command(command,arg,signal);if(r.length&&r[0]===expected)return;
   if(i+1<tries)await delay(100,undefined,{signal});
  }throw new Error('SD command '+command+' failed');
 }
 async #token(token:number,signal:AbortSignal,tries=10){for(let i=0;i<tries;i++)if((await this.#transfer(1,signal))[0]===token)return true;return false;}
 async #response(signal:AbortSignal){for(let i=0;i<10;i++){const byte=(await this.#transfer(1,signal))[0];if(byte!==255)return byte;}return 255;}
 async #block(size:number,signal:AbortSignal){
  const status=await this.#response(signal),token=await this.#token(254,signal);
  if(status!==0||!token){for(let remaining=size+2;remaining>0;remaining-=32)await this.#send(new Uint8Array(Math.min(32,remaining)).fill(255),signal);await this.#token(255,signal);throw new Error('SD read rejected or missing data token');}
  const data=new Uint8Array(size);for(let offset=0;offset<size;offset+=32)data.set(await this.#transfer(Math.min(32,size-offset),signal),offset);
  const crc=await this.#transfer(2,signal),ready=await this.#token(255,signal);
  if(!ready)throw new Error('SD read stayed busy');if(sdCRC16(data)!==crc[0]*256+crc[1])throw new Error('SD data CRC mismatch');return data;
 }
 initialize(signal:AbortSignal):Promise<SDCardInfo>{return this.#operation(signal,async signal=>{
  if(this.#info)return {...this.#info};
  await this.#check(1,0,0,signal);const r=await this.#command(8,0x10a,signal);let version:1|2;
  if(r.length&&(r[0]&4))version=1;
  else{if(r.length<5||r[0]!==1||r[3]!==1||r[4]!==10)throw new Error('Invalid SD voltage response');version=2;}
  // Unlike the legacy log-only failure, do not continue if CRC cannot be enabled.
  await this.#check(1,59,1,signal);
  if(version===2)await this.#check(0,41,0x40000000,signal,15,true);
  const ocr=await this.#command(58,0,signal);
  if(ocr.length<5||ocr[0]!== (version===1?1:0)||version===1&&ocr[2]!==255)throw new Error('Invalid SD OCR');
  const highCapacity=version===2&&(ocr[1]&64)!==0;
  if(version===1)await this.#check(0,41,0,signal,15,true);
  await this.#check(0,16,512,signal,5);
  await this.#send(sdCommand(10,0),signal);const cid=await this.#block(16,signal);register(cid);
  await this.#send(sdCommand(9,0),signal);const csd=await this.#block(16,signal),capacity=sdCapacity(csd);
  if(highCapacity!==(csd[0]>>>6===1))throw new Error('SD OCR and CSD addressing disagree');
  const info:SDCardInfo={version,highCapacity,...capacity,manufacturerId:cid[0],oem:ascii(cid.subarray(1,3)),product:ascii(cid.subarray(3,8)),revision:(cid[8]>>>4)+'.'+(cid[8]&15),serial:Buffer.from(cid.subarray(9,13)).toString('hex').toUpperCase(),manufacturingDate:(cid[14]&15)+'/'+(2000+((cid[13]&15)<<4)+(cid[14]>>>4))};
  this.#info=info;return {...info};
 });}
 #address(sector:number,write=false){
  const info=this.#info;if(!info)throw new Error('SD card not initialized');if(!Number.isInteger(sector)||sector<0||sector>=info.sectors)throw new RangeError('SD sector out of range');if(write&&info.writeProtected)throw new Error('SD card is write protected');
  const address=info.highCapacity?sector:sector*512;if(address>0xffffffff)throw new RangeError('SD byte address overflow');return address;
 }
 readSector(sector:number,signal:AbortSignal):Promise<Uint8Array>{return this.#operation(signal,async signal=>{const address=this.#address(sector);await this.#send(sdCommand(17,address),signal);return this.#block(512,signal);});}
 writeSector(sector:number,input:Uint8Array,signal:AbortSignal):Promise<void>{
  if(!(input instanceof Uint8Array)||input.length>512)return Promise.reject(new RangeError('SD sector requires at most 512 bytes'));
  const frame=new Uint8Array(515);frame[0]=254;frame.set(input,1);const crc=sdCRC16(frame.subarray(1,513));frame[513]=crc>>>8;frame[514]=crc&255;
  return this.#operation(signal,async signal=>{
   const address=this.#address(sector,true);await this.#check(0,24,address,signal,2);
   for(let i=0;i<frame.length;i+=32)await this.#send(frame.subarray(i,i+32),signal);
   const response=await this.#response(signal),ready=await this.#token(255,signal,128);
   if(!ready)throw new Error('SD write stayed busy');const status=await this.#command(13,0,signal);
   if((response&31)!==5||status.length<2||status[0]!==0||status[1]!==0)throw new Error('SD write rejected');
  });
 }
 deinitialize(signal:AbortSignal):Promise<void>{return this.#operation(signal,async signal=>{const active=this.#info;this.#info=undefined;if(active){await this.#check(1,0,0,signal);await this.#check(1,59,0,signal);}});}
}
