import {Bmp180Sensor} from './bmp180.ts';
// Register protocol from klippy/extras/bme280.py (GPL-3.0-or-later).
// Forced conversion timing follows Bosch BME280 datasheet appendix B.
import {waitI2cConversion} from './i2c-conversion-wait.ts';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {Bme280Compensation} from './bme280-compensation.ts';
export interface Bme280Options {temperature:number;pressure:number;humidity:number;filter:number;}
export function readBme280Options(reader:ConfigurationReader,section:string):Readonly<Bme280Options>{const c=reader.section(section);return Object.freeze({temperature:c.getInt('bme280_oversample_temp',{defaultValue:2,minval:1,maxval:5}),pressure:c.getInt('bme280_oversample_pressure',{defaultValue:2,minval:0,maxval:5}),humidity:c.getInt('bme280_oversample_hum',{defaultValue:2,minval:0,maxval:5}),filter:c.getInt('bme280_iir_filter',{defaultValue:1,minval:0,maxval:4})});}
export function bme280ConversionMs(options:Bme280Options,humidity:boolean):number{
 if(!Number.isInteger(options.temperature)||options.temperature<1||options.temperature>5||![options.pressure,options.humidity].every(v=>Number.isInteger(v)&&v>=0&&v<=5)||!Number.isInteger(options.filter)||options.filter<0||options.filter>4)throw new Error('Invalid BME280 settings');
 const ratio=(code:number)=>code?2**(code-1):0;
 return 1.25+2.3*ratio(options.temperature)+(options.pressure?2.3*ratio(options.pressure)+.575:0)+(humidity&&options.humidity?2.3*ratio(options.humidity)+.575:0);
}
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;
export class Bme280Sensor {
 readonly #device:I2cDevice;readonly #options:Readonly<Bme280Options>;readonly #wait:Wait;
 #bmp180:Bmp180Sensor|undefined;
 #started=false;#ready=false;#busy=false;#failed=false;#fault:unknown;#compensation:Bme280Compensation|undefined;#humidity=false;
 constructor(device:I2cDevice,options:Bme280Options,wait:Wait=waitI2cConversion){bme280ConversionMs(options,true);this.#device=device;this.#options=Object.freeze({...options});this.#wait=wait;}
 async #transfer(data:readonly number[],n:number,signal:AbortSignal){signal.throwIfAborted();const bytes=await this.#device.transfer(Uint8Array.from(data),n,signal);signal.throwIfAborted();if(bytes.length!==n)throw new Error('Malformed BME280 response');return bytes;}
 async #pause(ms:number,signal:AbortSignal){signal.throwIfAborted();await this.#wait(ms,signal);signal.throwIfAborted();}
 async #idle(signal:AbortSignal){for(let i=0;i<50;i++){const status=(await this.#transfer([243],1,signal))[0];if(!(status&9))return;if(i<49)await this.#pause(10,signal);}throw new Error('BME280 busy timeout');}
 get chipType(){if(this.#bmp180&&this.#ready)return 'BMP180';return this.#ready?(this.#humidity?'BME280':'BMP280'):undefined;}
 get #control(){return (this.#options.temperature<<5)|(this.#options.pressure<<2);}
 async initialize(signal:AbortSignal):Promise<{temperature:number;pressure?:number;humidity?:number}>{
  signal.throwIfAborted();if(this.#started)throw new Error('BME280 cannot restart');this.#started=true;
  try{
   const id=(await this.#transfer([208],1,signal))[0];if(id===85){this.#bmp180=new Bmp180Sensor(this.#device,this.#options.pressure,this.#wait);const value=await this.#bmp180.initialize(signal);this.#ready=true;return value;}if(id!==0x58&&id!==0x60)throw new Error('Unsupported BME/BMP chip identity');this.#humidity=id===0x60;
   await this.#transfer([224,182],0,signal);await this.#pause(500,signal);await this.#idle(signal);
   const first=await this.#transfer([136],this.#humidity?26:24,signal),second=this.#humidity?await this.#transfer([225],7,signal):undefined;this.#compensation=new Bme280Compensation(first,second);
   await this.#transfer([245,this.#options.filter<<2],0,signal);
   if(this.#humidity)await this.#transfer([242,this.#options.humidity],0,signal);
   await this.#transfer([244,this.#control],0,signal);
   if((await this.#transfer([245],1,signal))[0]!==(this.#options.filter<<2)||(await this.#transfer([244],1,signal))[0]!==this.#control||this.#humidity&&(await this.#transfer([242],1,signal))[0]!==this.#options.humidity)throw new Error('BME280 configuration verification failed');
   this.#ready=true;return await this.sample(signal);
  }catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async sample(signal:AbortSignal):Promise<{temperature:number;pressure?:number;humidity?:number}>{
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#ready)throw new Error('BME280 not initialized');if(this.#busy)throw new Error('BME280 measurement already active');this.#busy=true;
  try{
   if(this.#bmp180)return await this.#bmp180.sample(signal);
   await this.#transfer([244,this.#control|1],0,signal);await this.#pause(bme280ConversionMs(this.#options,this.#humidity),signal);await this.#idle(signal);
   if((await this.#transfer([244],1,signal))[0]!==this.#control)throw new Error('BME280 conversion or configuration lost');
   const value=this.#compensation!.decode(await this.#transfer([247],this.#humidity?8:6,signal));
   return {temperature:value.temperature,...this.#options.pressure?{pressure:value.pressure}:{},...this.#humidity&&this.#options.humidity?{humidity:value.humidity!}:{}};
  }catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
