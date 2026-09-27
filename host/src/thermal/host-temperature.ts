// Host millidegree source from temperature_host.py; GPL-3.0-or-later.
import {open,constants,type FileHandle} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {TemperatureSensorState} from './temperature-sensor.ts';
export function readHostTemperature(reader:ConfigurationReader,section:string){
 const c=reader.section(section),minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),path=c.get('sensor_path',{defaultValue:'/sys/class/thermal/thermal_zone0/temp'}),gcodeId=c.get('gcode_id',{defaultValue:null});
 if(!isAbsolute(path)||/[\0\r\n]/.test(path)||gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid host temperature source');
 return Object.freeze({section,path,minimum,maximum,gcodeId:gcodeId??undefined});
}
export function parseHostTemperature(raw:string,minimum:number,maximum:number):number{
 const text=raw.trim();if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text))throw new Error('Invalid host temperature reading');
 const value=Number(text)/1000;if(!Number.isFinite(value)||value<minimum||value>maximum)throw new Error('Host temperature outside configured range');return value;
}
/** One bounded asynchronous file read at a time. Close joins in-flight work;
 * failures are latched and never publish a fabricated zero reading. */
export class HostTemperature {
 readonly state=new TemperatureSensorState();readonly section:string;
 #config:ReturnType<typeof readHostTemperature>;#file:FileHandle;#fault:(cause:unknown)=>void;
 #timer:ReturnType<typeof setTimeout>|undefined;#pending:Promise<void>|undefined;#closing:Promise<void>|undefined;#closed=false;#started=false;
 private constructor(config:ReturnType<typeof readHostTemperature>,file:FileHandle,fault:(cause:unknown)=>void){this.#config=config;this.section=config.section;this.#file=file;this.#fault=fault;}
 static async open(config:ReturnType<typeof readHostTemperature>,fault:(cause:unknown)=>void,signal:AbortSignal){
  config=Object.freeze({...config});
  if(!isAbsolute(config.path)||/[\0\r\n]/.test(config.path)||![config.minimum,config.maximum].every(Number.isFinite)||config.minimum< -273.15||config.maximum<=config.minimum)throw new Error('Invalid host temperature source');
  signal.throwIfAborted();const file=await open(config.path,constants.O_RDONLY|constants.O_NONBLOCK);
  try{signal.throwIfAborted();if(!(await file.stat()).isFile())throw new Error('Host temperature requires a regular file');signal.throwIfAborted();return new HostTemperature(config,file,fault);}catch(error){await file.close();throw error;}
 }
 async start(signal:AbortSignal):Promise<void>{
  if(this.#started||this.#closed)throw new Error('Host temperature cannot restart');signal.throwIfAborted();this.#started=true;
  await this.#read(signal);signal.throwIfAborted();
 }
 #read(signal?:AbortSignal):Promise<void>{
  if(this.#closed)return Promise.reject(new Error('Host temperature closed'));
  const run=(async()=>{
   const deadline=setTimeout(()=>this.#fail(new Error('Host temperature read timed out')),7000);deadline.unref();
   try{
    const bytes=Buffer.alloc(129);const {bytesRead}=await this.#file.read(bytes,0,bytes.length,0);signal?.throwIfAborted();
    if(this.#closed)throw new Error('Host temperature closed during read');
    if(bytesRead===0||bytesRead===bytes.length)throw new Error('Host temperature reading size invalid');
    const value=parseHostTemperature(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,bytesRead)),this.#config.minimum,this.#config.maximum);
    this.state.sample(performance.now()/1000,value);
    this.#timer=setTimeout(()=>{void this.#read().catch(()=>{});},1000);this.#timer.unref();
   }catch(error){if(!this.#closed)this.#fail(error);throw error;}finally{clearTimeout(deadline);}
  })();this.#pending=run;void run.finally(()=>{if(this.#pending===run)this.#pending=undefined;}).catch(()=>{});return run;
 }
 #fail(cause:unknown){if(this.#closed)return;this.#closed=true;clearTimeout(this.#timer);this.state.shutdown(cause instanceof Error?cause.message:'Host temperature failed');this.#fault(cause);}
 close(cause:unknown=new Error('Host temperature stopped')):Promise<void>{
  if(this.#closing)return this.#closing;this.#closed=true;clearTimeout(this.#timer);this.state.shutdown(cause instanceof Error?cause.message:'Host temperature stopped');
  this.#closing=(async()=>{await this.#pending?.catch(()=>{});await this.#file.close();})();return this.#closing;
 }
}
