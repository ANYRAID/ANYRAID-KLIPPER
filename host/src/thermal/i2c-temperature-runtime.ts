import {readBme280Options} from './bme280.ts';
import {isHtu21d,readHtuOptions} from './htu21d.ts';
import {i2cTemperatureModel,i2cTemperaturePeriod} from './i2c-temperature-model.ts';
import {fixedDecimal} from '../diagnostics/python-literal.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
interface TemperatureReading {temperature:number;humidity?:number;pressure?:number;}
import {TemperatureSensorState} from './temperature-sensor.ts';
export function readI2cTemperature(reader:ConfigurationReader,section:string){
 const c=reader.section(section),model=c.get('sensor_type'),minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),reportTime=i2cTemperaturePeriod(reader,section),gcodeId=c.get('gcode_id',{defaultValue:null});
 if(gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid I2C temperature G-code id');
 return Object.freeze({section,model,minimum,maximum,reportTime,...model==='BME280'?{bmeOptions:readBme280Options(reader,section)}:{},...isHtu21d(model)?{htuOptions:readHtuOptions(reader,section)}:{},gcodeId:gcodeId??undefined});
}
export interface I2cTemperatureClock {now():number;schedule(callback:()=>void,milliseconds:number):()=>void;}
const clock:I2cTemperatureClock={now:()=>performance.now()/1000,schedule(callback,ms){const timer=setTimeout(callback,ms);timer.unref();return ()=>clearTimeout(timer);}};
export interface I2cTemperatureSampler {initialize(signal:AbortSignal):Promise<TemperatureReading>;sample(signal:AbortSignal):Promise<TemperatureReading>;}
/** Periodic owner. A six-second acquisition deadline is separate from the
 * configured report interval; an old sample never extends its own lifetime. */
export class I2cTemperatureRuntime {
 readonly state=new TemperatureSensorState();readonly section:string;
 readonly #config:ReturnType<typeof readI2cTemperature>;readonly #sampler:I2cTemperatureSampler;readonly #clock:I2cTemperatureClock;readonly #fault:(cause:unknown)=>void;
 readonly #abort=new AbortController();#started=false;#closed=false;#humidity:number|undefined;#pressure:number|undefined;#last:number|undefined;#pending:Promise<void>|undefined;
 #cancelPoll:(()=>void)|undefined;#cancelDeadline:(()=>void)|undefined;
 #requesting=false;
 constructor(config:ReturnType<typeof readI2cTemperature>,sampler:I2cTemperatureSampler,fault:(cause:unknown)=>void,timer:I2cTemperatureClock=clock){
  if(![config.minimum,config.maximum].every(Number.isFinite)||config.minimum< -273.15||config.maximum<=config.minimum||(!Number.isFinite(config.reportTime)||!['LM75','BME280'].includes(config.model)&&!Number.isInteger(config.reportTime))||config.reportTime<i2cTemperatureModel(config.model).reportMinimum||config.reportTime>86400)throw new Error('Invalid I2C temperature runtime configuration');
  this.#config=Object.freeze({...config});this.section=config.section;this.#sampler=sampler;this.#clock=timer;this.#fault=fault;
 }
 getTemperature(){
  if(!this.#closed&&this.#last!==undefined&&this.#clock.now()>this.#last+this.#config.reportTime+6)this.#fail(new Error('I2C temperature sample expired'));
  return {...this.state.getTemperature(),...this.#humidity===undefined?{}:{humidity:this.#humidity},...this.#pressure===undefined?{}:{pressure:this.#pressure}};
 }
 get statusName(){return i2cTemperatureModel(this.#config.model).statusPrefix+' '+this.section.trim().split(/\s+/).at(-1);}
 get objectStatus(){this.getTemperature();return {...this.state.objectStatus,...this.#humidity===undefined?{}:{humidity:this.#config.model==='SHT3X'?Number(fixedDecimal(this.#humidity,1)):this.#humidity},...this.#pressure===undefined?{}:{pressure:this.#pressure}};}
 get sensorStatus(){const s=this.objectStatus;return {temperature:s.temperature,...s.humidity===undefined?{}:{humidity:s.humidity},...s.pressure===undefined?{}:{pressure:s.pressure}};}
 async start(signal:AbortSignal):Promise<void>{
  if(this.#started||this.#closed)throw new Error('I2C temperature runtime cannot restart');signal.throwIfAborted();this.#started=true;
  await this.#read(true,signal);
 }
 async requestSample(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(!this.#started||this.#closed)throw new Error('I2C temperature runtime is not active');
  if(this.#requesting)throw new Error('I2C temperature sample request pending');this.#requesting=true;
  // A target change waits for the previous acquisition, then requests its own
  // fresh measurement. It never assigns a new time to an old reading.
  try{this.#cancelPoll?.();await this.#pending;signal.throwIfAborted();if(this.#closed)throw new Error('I2C temperature runtime closed');
   this.#cancelPoll?.();await this.#read(false,signal);
  }finally{this.#requesting=false;}
 }
 #read(initial:boolean,external?:AbortSignal):Promise<void>{
  const signal=external?AbortSignal.any([external,this.#abort.signal]):this.#abort.signal;
  const run=(async()=>{
   const started=this.#clock.now();
   this.#cancelDeadline=this.#clock.schedule(()=>this.#fail(new Error('I2C temperature acquisition timed out')),6000);
   try{
    if(this.#last!==undefined&&started>this.#last+this.#config.reportTime+6)throw new Error('I2C temperature sample expired before poll');
    signal.throwIfAborted();const value=await (initial?this.#sampler.initialize(signal):this.#sampler.sample(signal));signal.throwIfAborted();
    if(this.#closed)throw new Error('I2C temperature runtime closed during sample');
    const humidityKind=i2cTemperatureModel(this.#config.model).humidity,validHumidity=humidityKind==='none'||humidityKind==='optional'&&value.humidity===undefined?value.humidity===undefined:typeof value.humidity==='number'&&Number.isFinite(value.humidity)&&value.humidity>=0&&value.humidity<=100&&(humidityKind!=='integer'||Number.isInteger(value.humidity));
    const validPressure=value.pressure===undefined||this.#config.model==='BME280'&&Number.isFinite(value.pressure)&&value.pressure>0;
    if(!Number.isFinite(value.temperature)||value.temperature<this.#config.minimum||value.temperature>this.#config.maximum||!validHumidity||!validPressure)throw new Error('I2C temperature reading outside configured range');
    const now=this.#clock.now();if(!Number.isFinite(started)||!Number.isFinite(now)||started<0||now<started||now-started>=6)throw new Error('Invalid or expired I2C temperature sample time');
    this.state.sample(now,value.temperature);this.#humidity=value.humidity;this.#pressure=value.pressure;this.#last=now;
    if(!this.#closed)this.#cancelPoll=this.#clock.schedule(()=>{void this.#read(false).catch(()=>{});},this.#config.reportTime*1000);
   }catch(error){if(!this.#closed)this.#fail(error);throw error;}finally{this.#cancelDeadline?.();this.#cancelDeadline=undefined;}
  })();this.#pending=run;void run.finally(()=>{if(this.#pending===run)this.#pending=undefined;}).catch(()=>{});return run;
 }
 #stop(cause:unknown){this.#closed=true;this.#cancelPoll?.();this.#cancelDeadline?.();this.#abort.abort(cause);this.state.shutdown(cause instanceof Error?cause.message:'I2C temperature stopped');}
 #fail(cause:unknown){if(this.#closed)return;this.#stop(cause);this.#fault(cause);}
 async close(cause:unknown=new Error('I2C temperature stopped')):Promise<void>{if(!this.#closed)this.#stop(cause);await this.#pending?.catch(()=>{});}
}
