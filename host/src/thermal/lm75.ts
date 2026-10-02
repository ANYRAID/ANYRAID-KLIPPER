// LM75 register layout from klippy/extras/lm75.py, GPL-3.0-or-later.
// Signed conversion follows TI LM75A datasheet section 7.6.2.
import {setTimeout as delay} from 'node:timers/promises';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
export function decodeLm75(data:Uint8Array):number{
 if(!(data instanceof Uint8Array)||data.length!==2)throw new Error('Malformed LM75 temperature');
 const raw=(data[0]<<1)|(data[1]>>>7);return (raw&256?raw-512:raw)*.5;
}
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;
export class Lm75Sensor {
 readonly #device:I2cDevice;readonly #wait:Wait;readonly #now:()=>number;
 #started=false;#ready=false;#busy=false;#failed=false;#fault:unknown;#nextRead=0;
 constructor(device:I2cDevice,wait:Wait=async(ms,signal)=>{await delay(Math.ceil(ms),undefined,{signal});},now:()=>number=()=>performance.now()){this.#device=device;this.#wait=wait;this.#now=now;}
 async initialize(signal:AbortSignal){
  signal.throwIfAborted();if(this.#started)throw new Error('LM75 cannot restart');this.#started=true;
  try{
   // Do not probe optional product-ID registers: unsupported registers can NACK.
   const config=await this.#device.transfer(Uint8Array.of(1),1,signal);signal.throwIfAborted();
   if(config.length!==1||config[0]&1)throw new Error('LM75 malformed configuration or shutdown mode');
   this.#nextRead=this.#now()+500;this.#ready=true;return await this.sample(signal);
  }catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async sample(signal:AbortSignal){
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#ready)throw new Error('LM75 not initialized');if(this.#busy)throw new Error('LM75 sample already active');this.#busy=true;
  try{
   // Reads abort conversion. Preserve at least the legacy 500 ms minimum
   // even when a heater target requests a fresh measurement immediately.
   while(this.#nextRead>this.#now()){await this.#wait(this.#nextRead-this.#now(),signal);signal.throwIfAborted();}
   const bytes=await this.#device.transfer(Uint8Array.of(0),2,signal);signal.throwIfAborted();
   const temperature=decodeLm75(bytes);this.#nextRead=this.#now()+500;return {temperature};
  }catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
