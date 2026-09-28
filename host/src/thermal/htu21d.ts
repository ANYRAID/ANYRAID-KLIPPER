// Protocol derived from klippy/extras/htu21d.py (GPL-3.0-or-later).
// Conversion/CRC follow manufacturer HTU21D, SHT21 and Si70xx datasheets.
import {setTimeout as delay} from 'node:timers/promises';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export const htuModels=['HTU21D','SHT21','SI7013','SI7020','SI7021'] as const;
export type HtuModel=typeof htuModels[number];
export const htuResolutions={TEMP14_HUM12:0,TEMP13_HUM10:128,TEMP12_HUM08:1,TEMP11_HUM11:129} as const;
export type HtuResolution=keyof typeof htuResolutions;
export function isHtu21d(model:string):model is HtuModel{return (htuModels as readonly string[]).includes(model);}
export function readHtuOptions(reader:ConfigurationReader,section:string){const c=reader.section(section),resolution=c.get('htu21d_resolution',{defaultValue:'TEMP12_HUM08'});if(!Object.hasOwn(htuResolutions,resolution))throw new Error('Invalid HTU21D resolution');return Object.freeze({resolution:resolution as HtuResolution,hold:c.getBoolean('htu21d_hold_master',{defaultValue:false})});}
const table=Uint8Array.from({length:256},(_,i)=>{let c=i;for(let j=0;j<8;j++)c=c&128?(c<<1)^49:c<<1;return c&255;});
export function htuCrc(word:number){if(!Number.isInteger(word)||word<0||word>65535)throw new Error('Invalid HTU21D word');return table[table[word>>>8]^(word&255)];}
function checkedWord(bytes:Uint8Array){if(bytes.length!==3)throw new Error('Malformed HTU21D response');const word=bytes[0]*256+bytes[1];if(htuCrc(word)!==bytes[2])throw new Error('HTU21D checksum mismatch');return word;}
export function decodeHtu21d(temperatureBytes:Uint8Array,humidityBytes:Uint8Array,model:HtuModel){
 if(!isHtu21d(model))throw new Error('Invalid HTU21D model');const t=checkedWord(temperatureBytes),h=checkedWord(humidityBytes);
 if((t&3)!==0||(h&3)!==2)throw new Error('HTU21D measurement type mismatch');
 const temperature=175.72*(t&0xfffc)/65536-46.85;
 let humidity=125*(h&0xfffc)/65536-6;
 // Only HTU21D specifies this additional coefficient. SHT21 does not.
 if(model==='HTU21D'&&temperature>=0&&temperature<=80)humidity+=(25-temperature)*-.15;
 humidity=Math.max(0,Math.min(100,humidity));return {temperature,humidity};
}
// Preserve the legacy conservative waits (milliseconds) for the first port.
// SHT21 no-hold OTP reload can restore default resolution: wait for the
// highest resolution plus its documented 2.5 ms OTP overhead.
const waits:Record<HtuModel,readonly (readonly [number,number])[]>={HTU21D:[[500,160],[250,500],[130,300],[120,800]],SHT21:[[850,290],[430,900],[220,400],[110,150]],SI7013:[[110,120],[700,500],[400,400],[300,700]],SI7020:[[110,120],[700,500],[400,400],[300,700]],SI7021:[[110,120],[700,500],[400,400],[300,700]]};
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;
export class Htu21dSensor {
 readonly #device:I2cDevice;readonly #model:HtuModel;readonly #hold:boolean;readonly #resolution:HtuResolution;readonly #wait:Wait;
 #started=false;#ready=false;#busy=false;#failed=false;#fault:unknown;#register=0;
 constructor(device:I2cDevice,model:HtuModel,options:{resolution:HtuResolution;hold:boolean},wait:Wait=async(ms,signal)=>{await delay(Math.ceil(ms),undefined,{signal});}){
  if(!isHtu21d(model)||!Object.hasOwn(htuResolutions,options.resolution)||typeof options.hold!=='boolean')throw new Error('Invalid HTU21D configuration');this.#device=device;this.#model=model;this.#hold=options.hold;this.#resolution=options.resolution;this.#wait=wait;
 }
 async #transfer(bytes:readonly number[],n:number,signal:AbortSignal){signal.throwIfAborted();const response=await this.#device.transfer(Uint8Array.from(bytes),n,signal);signal.throwIfAborted();if(response.length!==n)throw new Error('Malformed HTU21D response');return response;}
 async #pause(ms:number,signal:AbortSignal){signal.throwIfAborted();await this.#wait(ms,signal);signal.throwIfAborted();}
 async initialize(signal:AbortSignal){
  signal.throwIfAborted();if(this.#started)throw new Error('HTU21D cannot restart');this.#started=true;
  try{
   await this.#transfer([254],0,signal);await this.#pause(150,signal);
   // Serial identity is diagnostic in the legacy implementation, not an
   // authentication guarantee. CRC is mandatory even for unknown IDs.
   checkedWord(await this.#transfer([252,201],3,signal));
   const reg=(await this.#transfer([231],1,signal))[0];if(reg&4)throw new Error('HTU21D internal heater active');
   this.#register=(reg&126)|htuResolutions[this.#resolution];
   await this.#transfer([230,this.#register],0,signal);
   const configured=(await this.#transfer([231],1,signal))[0];if((configured&129)!==(this.#register&129)||configured&4)throw new Error('HTU21D resolution verification failed');
   this.#ready=true;return await this.sample(signal);
  }catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async #measurement(humidity:boolean,signal:AbortSignal){
  if(this.#hold)return this.#transfer([humidity?229:227],3,signal);
  if(this.#model==='SHT21')await this.#transfer([230,this.#register&~2],0,signal);
  await this.#transfer([humidity?245:243],0,signal);
  const index=Object.keys(htuResolutions).indexOf(this.#resolution),base=waits[this.#model][index][humidity?1:0],ms=this.#model==='SHT21'?Math.max(base,humidity?29:85)+3:base;
  await this.#pause(ms,signal);return this.#transfer([],3,signal);
 }
 async sample(signal:AbortSignal){
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#ready)throw new Error('HTU21D not initialized');if(this.#busy)throw new Error('HTU21D measurement already active');this.#busy=true;
  try{const temperature=await this.#measurement(false,signal);checkedWord(temperature);const humidity=await this.#measurement(true,signal);return decodeHtu21d(temperature,humidity,this.#model);}
  catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
