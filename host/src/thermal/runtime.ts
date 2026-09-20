import {TemperatureState,type TemperatureConfig} from './state.ts';
import {HeaterPWM,PIDControl,BangBangControl} from './control.ts';
import {HeaterCheck,type HeaterCheckConfig} from './verify.ts';
export interface HeaterOutput {
 configureMaximumDuration(seconds:number):void;
 schedule(time:number,power:number):void;
 /** Must cancel queued nonzero outputs as well as force the physical pin off. */
 turnOff():void;
}
export interface ThermalClock {system:number;print:number;}
export type ThermalTimer=(callback:()=>void)=>()=>void;
const timer:ThermalTimer=callback=>{const handle=setInterval(callback,1000);return ()=>clearInterval(handle);};
/** Single-use lifecycle. The output adapter must provide an MCU-side watchdog. */
export class HeaterRuntime {
 #state:TemperatureState;#pwm:HeaterPWM;#check:HeaterCheck;#control:PIDControl|BangBangControl;
 #output:HeaterOutput;#clock:()=>ThermalClock;#timer:ThermalTimer;#cancel:(()=>void)|undefined;
 #listeners=new Set<(reason:string)=>void>();
 #started=false;#stopped=false;#fault:string|undefined;#stopError:unknown;
 #startTime=0;#lastSystem=-Infinity;#lastPrint=-Infinity;#nextCheck=0;
 constructor(config:TemperatureConfig&{maxPower:number;reportDelay:number},control:PIDControl|BangBangControl,output:HeaterOutput,clock:()=>ThermalClock,verification:HeaterCheckConfig={},schedule:ThermalTimer=timer) {
  this.#state=new TemperatureState(config);this.#pwm=new HeaterPWM(config.maxPower,config.reportDelay);this.#check=new HeaterCheck(verification);
  this.#control=control;this.#output=output;this.#clock=clock;this.#timer=schedule;
 }
 #now():ThermalClock {
  const t=this.#clock();if(!Number.isFinite(t.system)||!Number.isFinite(t.print)||t.system<0||t.print<0||t.system<this.#lastSystem||t.print<this.#lastPrint)throw new Error('Invalid thermal clock');return t;
 }
 start():void {
  if(this.#started||this.#stopped)throw new Error('Heater runtime cannot restart');
  try {
   const active=()=>{if(this.#stopped)throw new Error('Heater stopped during startup');};
   const t=this.#now();active();this.#output.configureMaximumDuration(3);active();this.#output.turnOff();active();
   this.#started=true;this.#startTime=this.#lastSystem=t.system;this.#lastPrint=t.print;this.#nextCheck=t.system;
   this.#pwm.heartbeat(t.print);const cancel=this.#timer(()=>this.#tick());
   if(this.#stopped){try{cancel();}catch(error){this.#recordStopError(error);}active();}
   this.#cancel=cancel;
  }catch(error){this.shutdown('Heater startup failed');throw error;}
 }
 isBusy():boolean{
  this.#active();const state=this.#state.state;return this.#control.busy(state.smoothedTemperature,state.target);
 }
 get limits(){return this.#state.limits;}
 getTemperature(){
  try{return this.#state.status(this.#now().print);}
  catch(error){this.shutdown('Invalid thermal query clock');throw error;}
 }
 get status(){
  return {...this.#state.state,started:this.#started,stopped:this.#stopped,fault:this.#fault,shutdownError:this.#stopError};
 }
 #active():void {if(!this.#started||this.#stopped)throw new Error('Heater runtime is not active');}
 setTarget(target:number):void {
  this.#active();let t:ThermalClock;
  try{t=this.#now();}catch(error){this.shutdown('Invalid thermal clock');throw error;}
  if(target!==0&&this.#state.status(t.print).stale)throw new Error('Fresh temperature required before heating');
  this.#state.setTarget(target);
  if(target===0)try{this.#output.turnOff();this.#pwm.confirmOff();}catch(error){this.shutdown('Heater off command failed');throw error;}
 }
 sample(readTime:number,temperature:number):void {
  this.#active();
  try {
   this.#state.sample(readTime,temperature);const target=this.#state.state.target;
   const requested=this.#control.update(readTime,temperature,target),write=this.#pwm.update(readTime,requested,target);
   if(write)this.#output.schedule(write.time,write.power);
  }catch(error){this.shutdown('Heater sample or output failed');throw error;}
 }
 canExtrude():boolean {
  if(!this.#started||this.#stopped)return false;
  try{return this.#state.status(this.#now().print).canExtrude;}catch{this.shutdown('Invalid thermal clock');return false;}
 }
 #tick():void {
  if(this.#stopped)return;
  try {
   const t=this.#now();if(t.system-this.#lastSystem>5)throw new Error('Heater protection timer stalled');
   const status=this.#state.status(t.print);
   if(status.stale&&(this.#state.state.received||t.system-this.#startTime>7))throw new Error('Temperature sensor timed out');
   if(t.system>=this.#nextCheck&&this.#state.state.received) {
    this.#nextCheck=this.#check.check(t.system,status.temperature,status.target);
    if(this.#nextCheck===Infinity)throw new Error('Heater not heating at expected rate');
   }
   this.#pwm.heartbeat(t.print);this.#lastSystem=t.system;this.#lastPrint=t.print;
  }catch(error){this.shutdown(error instanceof Error?error.message:'Heater verification failed');}
 }
 subscribeShutdown(listener:(reason:string)=>void):()=>void{
  if(typeof listener!=='function'||this.#listeners.has(listener)||this.#listeners.size>=64)throw new Error('Invalid or excessive heater shutdown subscription');
  if(this.#stopped){this.#notify(listener);return ()=>{};}
  this.#listeners.add(listener);let attached=true;
  return ()=>{if(attached){attached=false;this.#listeners.delete(listener);}};
 }
 #recordStopError(error:unknown):void{this.#stopError=this.#stopError===undefined?error:new AggregateError([this.#stopError,error],'Heater shutdown failed');}
 #notify(listener:(reason:string)=>void):void{try{listener(this.#fault!);}catch(error){this.#recordStopError(error);}}
 shutdown(reason='Heater runtime stopped'):void {
  if(this.#stopped)return;this.#stopped=true;this.#fault=reason;
  this.#state.shutdown(reason);this.#pwm.shutdown();
  try{this.#cancel?.();}catch(error){this.#recordStopError(error);}this.#cancel=undefined;
  try{this.#output.turnOff();}catch(error){this.#recordStopError(error);}
  const listeners=[...this.#listeners];this.#listeners.clear();for(const listener of listeners)this.#notify(listener);
 }
 [Symbol.dispose]():void {this.shutdown();}
}
