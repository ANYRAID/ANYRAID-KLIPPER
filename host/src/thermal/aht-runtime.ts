import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {AhtReading} from './aht.ts';
import {TemperatureSensorState} from './temperature-sensor.ts';
export function readAhtTemperature(reader:ConfigurationReader,section:string){
 const c=reader.section(section),model=c.getChoice('sensor_type',{AHT10:'AHT10',AHT1X:'AHT1X',AHT2X:'AHT2X',AHT3X:'AHT3X'}),minimum=c.getFloat('min_temp',{defaultValue:-273.15,minval:-273.15}),maximum=c.getFloat('max_temp',{defaultValue:99999999.9,above:minimum}),reportTime=c.getInt('aht10_report_time',{defaultValue:30,minval:5,maxval:86400}),gcodeId=c.get('gcode_id',{defaultValue:null});
 if(gcodeId!==null&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid AHT G-code id');
 return Object.freeze({section,model,minimum,maximum,reportTime,gcodeId:gcodeId??undefined});
}
export interface AhtRuntimeClock {now():number;schedule(callback:()=>void,milliseconds:number):()=>void;}
const clock:AhtRuntimeClock={now:()=>performance.now()/1000,schedule(callback,ms){const timer=setTimeout(callback,ms);timer.unref();return ()=>clearTimeout(timer);}};
export interface AhtSampler {initialize(signal:AbortSignal):Promise<AhtReading>;sample(signal:AbortSignal):Promise<AhtReading>;}
/** Periodic owner. A six-second acquisition deadline is separate from the
 * configured report interval; an old sample never extends its own lifetime. */
export class AhtTemperatureRuntime {
 readonly state=new TemperatureSensorState();readonly section:string;
 readonly #config:ReturnType<typeof readAhtTemperature>;readonly #sampler:AhtSampler;readonly #clock:AhtRuntimeClock;readonly #fault:(cause:unknown)=>void;
 readonly #abort=new AbortController();#started=false;#closed=false;#humidity:number|undefined;#last:number|undefined;#pending:Promise<void>|undefined;
 #cancelPoll:(()=>void)|undefined;#cancelDeadline:(()=>void)|undefined;
 #requesting=false;
 constructor(config:ReturnType<typeof readAhtTemperature>,sampler:AhtSampler,fault:(cause:unknown)=>void,timer:AhtRuntimeClock=clock){
  if(![config.minimum,config.maximum].every(Number.isFinite)||config.minimum< -273.15||config.maximum<=config.minimum||!Number.isInteger(config.reportTime)||config.reportTime<5||config.reportTime>86400)throw new Error('Invalid AHT runtime configuration');
  this.#config=Object.freeze({...config});this.section=config.section;this.#sampler=sampler;this.#clock=timer;this.#fault=fault;
 }
 getTemperature(){
  if(!this.#closed&&this.#last!==undefined&&this.#clock.now()>this.#last+this.#config.reportTime+6)this.#fail(new Error('AHT sample expired'));
  return {...this.state.getTemperature(),...this.#humidity===undefined?{}:{humidity:this.#humidity}};
 }
 get objectStatus(){this.getTemperature();return {...this.state.objectStatus,...this.#humidity===undefined?{}:{humidity:this.#humidity}};}
 get sensorStatus(){const s=this.objectStatus;return {temperature:s.temperature,...this.#humidity===undefined?{}:{humidity:this.#humidity}};}
 async start(signal:AbortSignal):Promise<void>{
  if(this.#started||this.#closed)throw new Error('AHT runtime cannot restart');signal.throwIfAborted();this.#started=true;
  await this.#read(true,signal);
 }
 async requestSample(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(!this.#started||this.#closed)throw new Error('AHT runtime is not active');
  if(this.#requesting)throw new Error('AHT sample request pending');this.#requesting=true;
  // A target change waits for the previous acquisition, then requests its own
  // fresh measurement. It never assigns a new time to an old reading.
  try{this.#cancelPoll?.();await this.#pending;signal.throwIfAborted();if(this.#closed)throw new Error('AHT runtime closed');
   this.#cancelPoll?.();await this.#read(false,signal);
  }finally{this.#requesting=false;}
 }
 #read(initial:boolean,external?:AbortSignal):Promise<void>{
  const signal=external?AbortSignal.any([external,this.#abort.signal]):this.#abort.signal;
  const run=(async()=>{
   const started=this.#clock.now();
   this.#cancelDeadline=this.#clock.schedule(()=>this.#fail(new Error('AHT acquisition timed out')),6000);
   try{
    if(this.#last!==undefined&&started>this.#last+this.#config.reportTime+6)throw new Error('AHT sample expired before poll');
    signal.throwIfAborted();const value=await (initial?this.#sampler.initialize(signal):this.#sampler.sample(signal));signal.throwIfAborted();
    if(this.#closed)throw new Error('AHT runtime closed during sample');
    if(!Number.isFinite(value.temperature)||value.temperature<this.#config.minimum||value.temperature>this.#config.maximum||!Number.isInteger(value.humidity)||value.humidity<0||value.humidity>100)throw new Error('AHT reading outside configured range');
    const now=this.#clock.now();if(!Number.isFinite(started)||!Number.isFinite(now)||started<0||now<started||now-started>=6)throw new Error('Invalid or expired AHT sample time');
    this.state.sample(now,value.temperature);this.#humidity=value.humidity;this.#last=now;
    if(!this.#closed)this.#cancelPoll=this.#clock.schedule(()=>{void this.#read(false).catch(()=>{});},this.#config.reportTime*1000);
   }catch(error){if(!this.#closed)this.#fail(error);throw error;}finally{this.#cancelDeadline?.();this.#cancelDeadline=undefined;}
  })();this.#pending=run;void run.finally(()=>{if(this.#pending===run)this.#pending=undefined;}).catch(()=>{});return run;
 }
 #stop(cause:unknown){this.#closed=true;this.#cancelPoll?.();this.#cancelDeadline?.();this.#abort.abort(cause);this.state.shutdown(cause instanceof Error?cause.message:'AHT stopped');}
 #fail(cause:unknown){if(this.#closed)return;this.#stop(cause);this.#fault(cause);}
 async close(cause:unknown=new Error('AHT stopped')):Promise<void>{if(!this.#closed)this.#stop(cause);await this.#pending?.catch(()=>{});}
}
