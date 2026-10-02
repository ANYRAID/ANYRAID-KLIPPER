// Compensation follows klippy/extras/bme280.py (GPL-3.0-or-later).
// Preserve its floating arithmetic and truncation, not JS 32-bit shifts.
import {waitI2cConversion} from './i2c-conversion-wait.ts';
import type {I2cDevice} from '../drivers/i2c-mcu.ts';
export class Bmp180Compensation {
 readonly calibration:Readonly<Record<'AC1'|'AC2'|'AC3'|'AC4'|'AC5'|'AC6'|'B1'|'B2'|'MB'|'MC'|'MD',number>>;
 constructor(bytes:Uint8Array){
  if(!(bytes instanceof Uint8Array)||bytes.length!==22)throw Error('Malformed BMP180 calibration');
  if(bytes.every(v=>v===0)||bytes.every(v=>v===255))throw Error('Empty BMP180 calibration');
  const u=(i:number)=>bytes[i]*256+bytes[i+1],s=(i:number)=>u(i)>=32768?u(i)-65536:u(i);
  this.calibration=Object.freeze({AC1:s(0),AC2:s(2),AC3:s(4),AC4:u(6),AC5:u(8),AC6:u(10),B1:s(12),B2:s(14),MB:s(16),MC:s(18),MD:s(20)});
  if(this.calibration.AC4===0||this.calibration.AC5===0)throw Error('Invalid BMP180 calibration');Object.freeze(this);
 }
 decode(rawTemperature:number,rawPressure:number,oversampling:number){
  bmp180ConversionMs(oversampling);
  if(!Number.isInteger(rawTemperature)||rawTemperature<0||rawTemperature>65535||!Number.isInteger(rawPressure)||rawPressure<0||rawPressure>=2**(16+oversampling))throw Error('Invalid BMP180 raw measurement');
  const d=this.calibration;let x1=(rawTemperature-d.AC6)*d.AC5/32768;
  if(x1+d.MD===0)throw Error('Invalid BMP180 temperature divisor');
  let x2=d.MC*2048/(x1+d.MD);const b5=x1+x2,temperature=(b5+8)/16/10,b6=b5-4000;
  x1=(d.B2*(b6*b6/4096))/2048;x2=d.AC2*b6/2048;let x3=x1+x2;
  const truncated=Math.trunc(d.AC1*4+x3);if(!Number.isSafeInteger(truncated*2**oversampling))throw Error('Unsafe BMP180 pressure intermediate');
  const b3=(truncated*2**oversampling+2)/4;
  x1=d.AC3*b6/8192;x2=(d.B1*(b6*b6/4096))/65536;x3=((x1+x2)+2)/4;
  const b4=d.AC4*(x3+32768)/32768,b7=(rawPressure-b3)*(50000>>oversampling);
  if(b4===0)throw Error('Invalid BMP180 pressure divisor');
  let p=b7<0x80000000?(b7*2)/b4:(b7/b4)*2;
  x1=(p/256)*(p/256);x1=(x1*3038)/65536;x2=(-7357*p)/65536;p=p+(x1+x2+3791)/16;
  if(!Number.isFinite(temperature)||!Number.isFinite(p))throw Error('Non-finite BMP180 compensation');return {temperature,pressure:p/100};
 }
}
export function bmp180ConversionMs(oversampling:number){if(!Number.isInteger(oversampling)||oversampling<0||oversampling>3)throw Error('BMP180 pressure oversampling must be 0 to 3');return [4.5,7.5,13.5,25.5][oversampling];}
type Wait=(ms:number,signal:AbortSignal)=>Promise<void>;
/** Each pair is acquired atomically; no stale pressure or partial reading. */
export class Bmp180Sensor {
 readonly #device:I2cDevice;readonly #oversampling:number;readonly #wait:Wait;
 #started=false;#compensation:Bmp180Compensation|undefined;#busy=false;#failed=false;#fault:unknown;
 constructor(device:I2cDevice,oversampling:number,wait:Wait=waitI2cConversion){bmp180ConversionMs(oversampling);this.#device=device;this.#oversampling=oversampling;this.#wait=wait;}
 async #transfer(bytes:readonly number[],n:number,signal:AbortSignal){signal.throwIfAborted();const result=await this.#device.transfer(Uint8Array.from(bytes),n,signal);signal.throwIfAborted();if(result.length!==n)throw Error('Malformed BMP180 response');return result;}
 async #pause(ms:number,signal:AbortSignal){signal.throwIfAborted();await this.#wait(ms,signal);signal.throwIfAborted();}
 async initialize(signal:AbortSignal){
  signal.throwIfAborted();if(this.#started)throw Error('BMP180 cannot restart');this.#started=true;
  try{if((await this.#transfer([208],1,signal))[0]!==85)throw Error('Invalid BMP180 identity');await this.#transfer([224,182],0,signal);await this.#pause(500,signal);this.#compensation=new Bmp180Compensation(await this.#transfer([170],22,signal));return await this.sample(signal);}catch(error){this.#failed=true;this.#fault=error;throw error;}
 }
 async #convert(command:number,wait:number,n:number,signal:AbortSignal){
  await this.#transfer([244,command],0,signal);await this.#pause(wait,signal);
  // A JS timer may wake near a millisecond boundary. Never read while SCO is
  // set: bounded polling tolerates scheduling quantization, not stale data.
  for(let attempt=0;attempt<11;attempt++){
   const control=(await this.#transfer([244],1,signal))[0];
   if((control&~32)!==(command&~32))throw Error('BMP180 configuration lost');
   if(!(control&32))return await this.#transfer([246],n,signal);
   if(attempt<10)await this.#pause(2,signal);
  }
  throw Error('BMP180 conversion timeout');
 }
 async sample(signal:AbortSignal){
  signal.throwIfAborted();if(this.#failed)throw this.#fault;if(!this.#compensation)throw Error('BMP180 not initialized');if(this.#busy)throw Error('BMP180 measurement already active');this.#busy=true;
  try{const t=await this.#convert(46,4.5,2,signal),p=await this.#convert(52|(this.#oversampling<<6),bmp180ConversionMs(this.#oversampling),3,signal);return this.#compensation.decode(t[0]*256+t[1],(p[0]*65536+p[1]*256+p[2])>> (8-this.#oversampling),this.#oversampling);}catch(error){this.#failed=true;this.#fault=error;throw error;}finally{this.#busy=false;}
 }
}
