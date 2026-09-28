// AHT family protocol and conversion from klippy/extras/aht10.py.
// GPL-3.0-or-later; original Scott Mudge (2023), Lev Voronov (2025).
import {setTimeout as delay} from 'node:timers/promises';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
export type AhtModel='AHT10'|'AHT1X'|'AHT2X'|'AHT3X';
export interface AhtReading {temperature:number;humidity:number;}
type Wait=(milliseconds:number,signal:AbortSignal)=>Promise<void>;
const wait:Wait=async(ms,signal)=>{await delay(ms,undefined,{signal});};
/** Preserve original 20-bit temperature and integer humidity conversion.
 * Busy/uncalibrated frames are never valid thermal feedback. */
export function decodeAht(data:Uint8Array):AhtReading{
 if(!(data instanceof Uint8Array)||data.length!==6)throw new Error('Malformed AHT response');
 if(data[0]&0x80)throw new Error('AHT sensor busy');
 if(!(data[0]&0x08))throw new Error('AHT sensor uncalibrated');
 const temperature=(((data[3]&15)<<16)|(data[4]<<8)|data[5])*200/1048576-50;
 const humidity=Math.trunc((((data[1]<<16)|(data[2]<<8)|data[3])>>>4)*100/1048576);
 return {temperature,humidity};
}
/** One owner per physical device. A failed operation permanently retires it;
 * a configured runtime must propagate that failure to its MCU group. */
export class AhtSensor {
 readonly #device:I2cDevice;readonly #model:AhtModel;readonly #wait:Wait;
 #started=false;#ready=false;#busy=false;#failed=false;#fault:unknown;
 constructor(device:I2cDevice,model:AhtModel,timer:Wait=wait){
  if(!['AHT10','AHT1X','AHT2X','AHT3X'].includes(model))throw new Error('Invalid AHT model');
  this.#device=device;this.#model=model;this.#wait=timer;
 }
 async #pause(ms:number,signal:AbortSignal){signal.throwIfAborted();await this.#wait(ms,signal);signal.throwIfAborted();}
 async #transfer(bytes:readonly number[],read:number,signal:AbortSignal){signal.throwIfAborted();const result=await this.#device.transfer(Uint8Array.from(bytes),read,signal);signal.throwIfAborted();if(result.length!==read)throw new Error('Malformed AHT response');return result;}
 async initialize(signal:AbortSignal):Promise<AhtReading>{
  if(this.#started)throw new Error('AHT sensor cannot restart');signal.throwIfAborted();this.#started=true;
  try{
   if(this.#model==='AHT10'||this.#model==='AHT1X'){await this.#transfer([0xe1,8,0],0,signal);await this.#pause(40,signal);}
   else{if(this.#model==='AHT2X')await this.#transfer([0xbe,8,0],0,signal);await this.#pause(100,signal);}
   this.#ready=true;return await this.sample(signal);
  }catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async sample(signal:AbortSignal):Promise<AhtReading>{
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#ready)throw new Error('AHT sensor not initialized');if(this.#busy)throw new Error('AHT measurement already active');this.#busy=true;
  try{
   // Original implementation makes six attempts (cycles > 5).
   for(let attempt=0;attempt<6;attempt++){
    await this.#transfer([0xac,0x33,0],0,signal);await this.#pause(110,signal);
    const data=await this.#transfer([],6,signal);if(!(data[0]&0x80))return decodeAht(data);
   }
   await this.#transfer([0xba],0,signal);await this.#pause(20,signal);throw new Error('AHT sensor remained busy after six measurements');
  }catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
