import {TemperatureState,type TemperatureConfig} from './state.ts';
import {HeaterPWM,PIDControl,BangBangControl} from './control.ts';
import {HeaterCheck,type HeaterCheckConfig} from './verify.ts';
import {PWMGenerationSuperseded} from '../outputs/generation-pwm.ts';
import type {ThermalClock,ThermalTimer} from './runtime.ts';
export interface ConfirmedHeaterOutput {
 readonly configuration:Readonly<{cycleTime:number;maximumDuration:number;defaultPower:number;initialPower:number}>;
 reset(signal:AbortSignal):Promise<void>;
 setPWM(time:number,power:number,signal:AbortSignal):Promise<void>;
 /** Must confirm independent device stop and settle accepted host writes. */
 stop(cause:unknown):Promise<void>;
}
const timer:ThermalTimer=callback=>{const handle=setInterval(callback,1000);return ()=>clearInterval(handle);};
/** Acknowledged lifecycle around the same pure thermal math as HeaterRuntime.
 * The caller must await start, target zero, and shutdown. Samples never await IO. */
export class AsyncHeaterRuntime {
 #state:TemperatureState;#pwm:HeaterPWM;#check:HeaterCheck;#control:PIDControl|BangBangControl;
 #output:ConfirmedHeaterOutput;#clock:()=>ThermalClock;#timer:ThermalTimer;#cancel:(()=>void)|undefined;
 #phase:'idle'|'starting'|'active'|'resetting'|'stopping'|'stopped'|'failed'='idle';
 #abort=new AbortController();#stop:Promise<void>|undefined;#writes=new Set<Promise<void>>();
 #listeners=new Set<(reason:string)=>void>();#errors:unknown[]=[];#cause:unknown;#outputStopped=false;#everStarted=false;
 #lastSystem=-Infinity;#lastPrint=-Infinity;#lastTick=0;#startTime=0;#nextCheck=0;
 constructor(config:TemperatureConfig&{maxPower:number;reportDelay:number},control:PIDControl|BangBangControl,output:ConfirmedHeaterOutput,clock:()=>ThermalClock,verification:HeaterCheckConfig={},schedule:ThermalTimer=timer){
  const protection=output.configuration;
  if(protection.initialPower!==0||protection.defaultPower!==0||protection.maximumDuration!==3||!Number.isFinite(protection.cycleTime)||protection.cycleTime<=0||protection.cycleTime>config.reportDelay)throw new Error('Heater output requires zero initial/default power, three-second watchdog and valid PWM cycle');
  this.#state=new TemperatureState(config);this.#pwm=new HeaterPWM(config.maxPower,config.reportDelay);this.#check=new HeaterCheck(verification);
  this.#control=control;this.#output=output;this.#clock=clock;this.#timer=schedule;
 }
 get limits(){return this.#state.limits;}
 get status(){return {...this.#state.state,phase:this.#phase,started:this.#everStarted,stopped:this.#stop!==undefined,cause:this.#cause,outputStopConfirmed:this.#outputStopped,pendingWrites:this.#writes.size,shutdownErrors:[...this.#errors]};}
 #now():ThermalClock{
  const time=this.#clock();if(!Number.isFinite(time.system)||!Number.isFinite(time.print)||time.system<0||time.print<0||time.system<this.#lastSystem||time.print<this.#lastPrint)throw new Error('Invalid thermal clock');
  this.#lastSystem=time.system;this.#lastPrint=time.print;return time;
 }
 #resetOutput(signal:AbortSignal):Promise<void>{const pending=this.#output.reset(signal);if(!pending||typeof pending.then!=='function')throw new Error('Heater reset must provide completion confirmation');return pending;}
 #active():void{if(this.#phase!=='active')throw new Error('Async heater runtime is not active');}
 #expect(phase:string):void{if(this.#phase!==phase)throw this.#cause??new Error('Heater operation invalidated');}
 #trip(cause:unknown):void{void this.shutdown(cause).catch(()=>{});}
 async start(signal:AbortSignal=this.#abort.signal):Promise<void>{
  signal.throwIfAborted();if(this.#phase!=='idle')throw new Error('Async heater runtime cannot restart');this.#phase='starting';
  try{
   this.#now();await this.#resetOutput(AbortSignal.any([signal,this.#abort.signal]));signal.throwIfAborted();this.#expect('starting');
   const time=this.#now();signal.throwIfAborted();this.#expect('starting');this.#startTime=this.#lastTick=time.system;this.#nextCheck=time.system;this.#pwm.heartbeat(time.print);
   this.#phase='active';this.#everStarted=true;
   const cancel=this.#timer(()=>this.#tick());if(this.#phase!=='active'){try{cancel();}catch(error){this.#errors.push(error);}this.#expect('active');}this.#cancel=cancel;signal.throwIfAborted();
  }catch(error){try{await this.shutdown(error);}catch(stopError){throw new AggregateError([error,stopError],'Heater startup and stop failed',{cause:error});}throw error;}
 }
 async setTarget(target:number,signal:AbortSignal=this.#abort.signal):Promise<void>{
  signal.throwIfAborted();this.#active();
  let time:ThermalClock;try{time=this.#now();}catch(error){this.#trip(error);throw error;}
  signal.throwIfAborted();this.#active();
  if(target!==0&&this.#state.status(time.print).stale)throw new Error('Fresh temperature required before heating');
  this.#state.setTarget(target);
  if(target!==0)return;
  this.#phase='resetting';
  try{
   await this.#resetOutput(AbortSignal.any([signal,this.#abort.signal]));signal.throwIfAborted();this.#expect('resetting');this.#pwm.confirmOff();this.#phase='active';
  }catch(error){try{await this.shutdown(error);}catch(stopError){throw new AggregateError([error,stopError],'Heater off and stop failed',{cause:error});}throw error;}
 }
 sample(time:number,temperature:number):void{
  if(this.#phase!=='active'&&this.#phase!=='resetting')throw new Error('Async heater is not accepting samples');
  try{
   this.#state.sample(time,temperature);const target=this.#state.state.target;
   const requested=this.#control.update(time,temperature,target);
   if(this.#phase!=='active')return;
   const write=this.#pwm.update(time,requested,target);if(!write)return;
   if(this.#writes.size>=32)throw new Error('Heater pending output limit exceeded');
   // Track before calling the adapter: it may synchronously initiate shutdown.
   const deferred=Promise.withResolvers<void>(),pending=deferred.promise;
   this.#writes.add(pending);void pending.then(()=>this.#writes.delete(pending));
   const fail=(error:unknown)=>{if(!(error instanceof PWMGenerationSuperseded))this.#trip(error);deferred.resolve();};
   try{const sent=this.#output.setPWM(write.time,write.power,this.#abort.signal);if(!sent||typeof sent.then!=='function')throw new Error('Heater PWM must provide completion confirmation');void sent.then(deferred.resolve,fail);}
   catch(error){fail(error);throw error;}
  }catch(error){this.#trip(error);throw error;}
 }
 getTemperature(){try{return this.#state.status(this.#now().print);}catch(error){this.#trip(error);throw error;}}
 canExtrude():boolean{if(this.#phase!=='active')return false;try{return this.getTemperature().canExtrude;}catch{return false;}}
 isBusy():boolean{this.#active();const state=this.#state.state;return this.#control.busy(state.smoothedTemperature,state.target);}
 #tick():void{
  if(this.#phase!=='active'&&this.#phase!=='resetting')return;
  try{
   const time=this.#now();if(time.system-this.#lastTick>5)throw new Error('Heater protection timer stalled');
   const status=this.#state.status(time.print);
   if(status.stale&&(this.#state.state.received||time.system-this.#startTime>7))throw new Error('Temperature sensor timed out');
   if(time.system>=this.#nextCheck&&this.#state.state.received){this.#nextCheck=this.#check.check(time.system,status.temperature,status.target);if(this.#nextCheck===Infinity)throw new Error('Heater not heating at expected rate');}
   this.#pwm.heartbeat(time.print);this.#lastTick=time.system;
  }catch(error){this.#trip(error);}
 }
 subscribeShutdown(listener:(reason:string)=>void):()=>void{
  if(typeof listener!=='function'||this.#listeners.has(listener)||this.#listeners.size>=64)throw new Error('Invalid heater shutdown subscription');
  if(this.#stop){try{listener(this.#state.state.fault!);}catch(error){this.#errors.push(error);}return ()=>{};}
  this.#listeners.add(listener);return ()=>{this.#listeners.delete(listener);};
 }
 shutdown(cause:unknown=new Error('Async heater stopped')):Promise<void>{
  if(this.#stop)return this.#stop;
  const deferred=Promise.withResolvers<void>();this.#stop=deferred.promise;this.#phase='stopping';this.#cause=cause;
  const reason=cause instanceof Error?cause.message:String(cause);this.#state.shutdown(reason);this.#pwm.shutdown();this.#abort.abort(cause);
  try{this.#cancel?.();}catch(error){this.#errors.push(error);}this.#cancel=undefined;
  // Publish the fence before any callback can re-enter; output stop starts now.
  let stopped:Promise<void>;try{stopped=this.#output.stop(cause);if(!stopped||typeof stopped.then!=='function')throw new Error('Heater stop must provide completion confirmation');}catch(error){stopped=Promise.reject(error);}
  const listeners=[...this.#listeners];this.#listeners.clear();for(const listener of listeners)try{listener(reason);}catch(error){this.#errors.push(error);}
  void (async()=>{
   try{await stopped;this.#outputStopped=true;}catch(error){this.#errors.push(error);}
   await Promise.allSettled([...this.#writes]);
   if(this.#errors.length){this.#phase='failed';deferred.reject(new AggregateError([...this.#errors],'Heater shutdown failed',{cause:this.#cause}));}
   else{this.#phase='stopped';deferred.resolve();}
  })();
  return deferred.promise;
 }
}
