// Protocol/conversion from klippy/extras/sht3x.py, GPL-3.0-or-later.
// Original Copyright (C) 2024 Timofey Titovets.
import {setTimeout as delay} from 'node:timers/promises';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
const crcTable=Uint8Array.from({length:256},(_,i)=>{let crc=i;for(let bit=0;bit<8;bit++)crc=(crc&128)?(crc<<1)^0x31:crc<<1;return crc&255;});
export function sht3xCrc(word:number):number{
 if(!Number.isInteger(word)||word<0||word>65535)throw new RangeError('Invalid SHT3X word');
 return crcTable[crcTable[255^(word>>>8)]^(word&255)];
}
function word(data:Uint8Array,offset:number){const raw=data[offset]*256+data[offset+1];if(sht3xCrc(raw)!==data[offset+2])throw new Error('SHT3X checksum mismatch');return raw;}
export function decodeSht3x(data:Uint8Array){
 if(!(data instanceof Uint8Array)||data.length!==6)throw new Error('Malformed SHT3X response');
 // Validate both words before publishing either field. A failed CRC is not
 // a fresh copy of the previous temperature or humidity.
 const temperature=word(data,0),humidity=word(data,3);
 return {temperature:-45+175*temperature/65535,humidity:100*humidity/65535};
}
type Wait=(milliseconds:number,signal:AbortSignal)=>Promise<void>;
const wait:Wait=async(ms,signal)=>{await delay(Math.ceil(ms),undefined,{signal});};
export class Sht3xSensor {
 readonly #device:I2cDevice;readonly #wait:Wait;#started=false;#ready=false;#busy=false;#failed=false;#fault:unknown;
 constructor(device:I2cDevice,timer:Wait=wait){this.#device=device;this.#wait=timer;}
 async #pause(ms:number,signal:AbortSignal){signal.throwIfAborted();await this.#wait(ms,signal);signal.throwIfAborted();}
 async #transfer(bytes:readonly number[],n:number,signal:AbortSignal){signal.throwIfAborted();const result=await this.#device.transfer(Uint8Array.from(bytes),n,signal);signal.throwIfAborted();if(result.length!==n)throw new Error('Malformed SHT3X response');return result;}
 async initialize(signal:AbortSignal){
  signal.throwIfAborted();if(this.#started)throw new Error('SHT3X cannot restart');this.#started=true;
  try{
   await this.#transfer([0x30,0x93],0,signal);await this.#pause(1.5,signal);
   await this.#transfer([0x30,0xa2],0,signal);await this.#pause(1.5,signal);
   word(await this.#transfer([0xf3,0x2d],3,signal),0);
   await this.#transfer([0x22,0x36],0,signal);await this.#pause(15.5,signal);
   this.#ready=true;return await this.sample(signal);
  }catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async sample(signal:AbortSignal){
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#ready)throw new Error('SHT3X not initialized');if(this.#busy)throw new Error('SHT3X measurement already active');this.#busy=true;
  try{return decodeSht3x(await this.#transfer([0xe0,0],6,signal));}
  catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
