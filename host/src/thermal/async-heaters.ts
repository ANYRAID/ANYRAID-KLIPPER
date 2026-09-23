// Heater command registry derived from klippy/extras/heaters.py (GPL-3.0-or-later).
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {fixedDecimal} from '../diagnostics/python-literal.ts';
import {AsyncHeaterRuntime} from './async-runtime.ts';
import {bindHeaterCommands} from './heater-commands.ts';
import type {TemperatureSensor,StandardHeaterCommands} from './heaters.ts';
import {waitForTemperature,waitForTemperatureCondition,type WaitTemperature,type TemperatureWaitTimer} from './temperature-wait.ts';
interface SensorEntry {sensor:TemperatureSensor;gcodeId?:string;}
interface Entry {name:string;heater:AsyncHeaterRuntime;gcodeId?:string;}
/** Owns configured heater lifecycles. The supplied barrier orders target changes
 * with the motion queue; it must settle when that ordering is established. */
export class AsyncPrinterHeaters {
 #listeners=new Set<(reason:string)=>void>();
 #starting=false;#stopSettled=false;#stop:Promise<void>|undefined;#off:Promise<void>|undefined;#zero=new Map<AsyncHeaterRuntime,Promise<void>>();
 #detachers=new Set<()=>void>();#dispatches=new Set<GCodeDispatch>();
 #sensors=new Map<string,SensorEntry>();#waits=new Set<AbortController>();
 #waitTimeout:number;#waitTimer:TemperatureWaitTimer|undefined;
 #entries=new Map<string,Entry>();#started=false;#closed=false;#generation=0;
 #reason:string|undefined;#errors:unknown[]=[];#barrier:(signal:AbortSignal)=>void|Promise<void>;
 constructor(beforeTarget:(signal:AbortSignal)=>void|Promise<void>,options:{waitTimeoutSeconds?:number;waitTimer?:TemperatureWaitTimer}={}){
  this.#barrier=beforeTarget;this.#waitTimeout=options.waitTimeoutSeconds??1800;this.#waitTimer=options.waitTimer;
  if(!Number.isFinite(this.#waitTimeout)||this.#waitTimeout<=0||this.#waitTimeout>86400)throw new RangeError('Invalid temperature wait timeout');
 }
 registerSensor(name:string,sensor:TemperatureSensor,gcodeId?:string):void{
  if(this.#started||this.#starting||this.#closed||!name.trim()||name.length>256||/[\u0000-\u001f\u007f]/u.test(name)||this.#sensors.has(name)||this.#sensors.size>=256)throw new Error('Invalid or duplicate temperature sensor');
  if(gcodeId!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  if(gcodeId!==undefined)for(const entry of this.#sensors.values())if(entry.gcodeId===gcodeId)throw new Error('Duplicate temperature G-code id');
  this.#sensors.set(name,{sensor,gcodeId});
 }
 register(name:string,heater:AsyncHeaterRuntime,gcodeId?:string):void{
  const short=name.trim().split(/\s+/).at(-1)!;
  if(this.#started||this.#starting||this.#closed||heater.status.stopped||!short||name.length>256||/[\u0000-\u001f\u007f]/u.test(name)||this.#entries.has(short)||this.#entries.size>=64)throw new Error('Invalid or duplicate heater registration');
  if(gcodeId!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  for(const entry of this.#entries.values())if(entry.heater===heater||gcodeId!==undefined&&entry.gcodeId===gcodeId)throw new Error('Duplicate heater or temperature G-code id');
  const detach=heater.subscribeShutdown(reason=>{void this.shutdown(`Heater '${short}' stopped: ${reason}`).catch(()=>{});});
  try{this.registerSensor(name,heater,gcodeId);this.#entries.set(short,{name,heater,gcodeId});this.#detachers.add(detach);}
  catch(error){detach();throw error;}
 }
 get status(){return {started:this.#started,starting:this.#starting,turningOff:this.#off!==undefined,stopConfirmed:this.#stopSettled&&Array.from(this.#entries.values()).every(e=>e.heater.status.outputStopConfirmed),closed:this.#closed,fault:this.#reason,shutdownErrors:[...new Set([...this.#errors,...Array.from(this.#entries.values(),e=>e.heater.status.shutdownErrors).flat()])],available_heaters:Array.from(this.#entries.values(),e=>e.name),available_sensors:[...this.#sensors.keys()]};}
 async start(signal:AbortSignal=new AbortController().signal):Promise<void>{
  signal.throwIfAborted();if(this.#started||this.#starting||this.#closed)throw new Error('Heater registry cannot restart');this.#starting=true;
  try{
   for(const entry of this.#entries.values()){await entry.heater.start(signal);signal.throwIfAborted();if(this.#closed)throw new Error('Heater registry stopped during startup');}
   this.#started=true;
  }catch(error){try{await this.shutdown('Heater registry startup failed');}catch(stopError){throw new AggregateError([error,stopError],'Heater startup and shutdown failed',{cause:error});}throw error;}
  finally{this.#starting=false;}
 }
 getTemperature(name:string):WaitTemperature{
  const heater=this.#entries.get(name)?.heater;if(!heater)throw new GCodeError(`Unknown heater '${name}'`);return heater.getTemperature();
 }
 report():string{
  if(!this.#started)return 'T:0';
  const entries=Array.from(this.#sensors.values()).filter(e=>e.gcodeId!==undefined).sort((a,b)=>a.gcodeId!<b.gcodeId!?-1:1);
  return entries.map(e=>{const state=e.sensor.getTemperature();return `${e.gcodeId}:${fixedDecimal(state.temperature,1)} /${fixedDecimal(state.target,1)}`;}).join(' ')||'T:0';
 }
 async setTarget(name:string,target:number,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  const entry=this.#entries.get(name);if(!entry)throw new GCodeError(`Unknown heater '${name}'`);
  const {minimum,maximum}=entry.heater.limits;
  if(!Number.isFinite(target)||target<0||target!==0&&(target<minimum||target>maximum))throw new GCodeError('Requested temperature out of range');
  if(!this.#started||this.#starting||this.#closed||this.#off!==undefined)throw new GCodeError('Heater registry is not active');
  const generation=this.#generation;
  await this.#barrier(signal);signal.throwIfAborted();
  if(this.#closed||generation!==this.#generation)throw new GCodeError('Heater target invalidated by shutdown or turn off');
  try{await this.#target(entry.heater,target,signal);signal.throwIfAborted();}catch(error){try{await this.shutdown('Heater target command failed');}catch(stopError){throw new AggregateError([error,stopError],'Heater target and shutdown failed',{cause:error});}throw error;}
 }
 /** Validate the whole group, then cross one motion boundary before starting
  * independent heater targets. Preparation must not race two native drains. */
 async setTargets(targets:readonly {name:string;target:number}[],signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();
  if(!targets.length||targets.length>64||new Set(targets.map(t=>t.name)).size!==targets.length)throw new GCodeError('Invalid heater target batch');
  const entries=targets.map(({name,target})=>{
   const entry=this.#entries.get(name);if(!entry)throw new GCodeError(`Unknown heater '${name}'`);
   const {minimum,maximum}=entry.heater.limits;
   if(!Number.isFinite(target)||target<0||target!==0&&(target<minimum||target>maximum))throw new GCodeError('Requested temperature out of range');
   return {heater:entry.heater,target};
  });
  if(!this.#started||this.#starting||this.#closed||this.#off!==undefined)throw new GCodeError('Heater registry is not active');
  const generation=this.#generation;
  await this.#barrier(signal);signal.throwIfAborted();
  if(this.#closed||generation!==this.#generation)throw new GCodeError('Heater target invalidated by shutdown or turn off');
  try{await Promise.all(entries.map(({heater,target})=>this.#target(heater,target,signal)));signal.throwIfAborted();}catch(error){try{await this.shutdown('Heater target command failed');}catch(stopError){throw new AggregateError([error,stopError],'Heater target and shutdown failed',{cause:error});}throw error;}
 }
 async wait(name:string,minimum:number|undefined,maximum:number|undefined,signal:AbortSignal,report:()=>void=()=>{}):Promise<void>{
  if(minimum===undefined&&maximum===undefined||minimum!==undefined&&!Number.isFinite(minimum)||maximum!==undefined&&!Number.isFinite(maximum)||(maximum??Infinity)<=(minimum??-Infinity))throw new GCodeError('Invalid temperature wait range');
  const sensor=this.#entries.get(name)?.heater??this.#sensors.get(name)?.sensor;
  if(!sensor)throw new GCodeError(`Unknown temperature sensor '${name}'`);
  await this.#observe(signal,local=>waitForTemperature({minimum,maximum,timeoutSeconds:this.#waitTimeout,signal:local,read:()=>sensor.getTemperature(),report,timer:this.#waitTimer}));
 }
 async waitUntilStable(name:string,signal:AbortSignal,report:()=>void=()=>{}):Promise<void>{
  const heater=this.#entries.get(name)?.heater;if(!heater)throw new GCodeError(`Unknown heater '${name}'`);
  await this.#observe(signal,local=>waitForTemperatureCondition({timeoutSeconds:this.#waitTimeout,signal:local,read:()=>heater.getTemperature(),ready:()=>!heater.isBusy(),report,timer:this.#waitTimer}));
 }
 async #observe(signal:AbortSignal,run:(signal:AbortSignal)=>Promise<void>):Promise<void>{
  if(!this.#started||this.#starting||this.#closed||this.#off!==undefined)throw new GCodeError('Heater registry is not active');
  signal.throwIfAborted();
  if(this.#waits.size>=64)throw new GCodeError('Too many temperature waits');
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});this.#waits.add(controller);
  try{await run(controller.signal);}
  catch(error){if(!controller.signal.aborted)try{await this.shutdown('Temperature wait failed');}catch(stopError){throw new AggregateError([error,stopError],'Temperature wait and shutdown failed',{cause:error});}throw error;}
  finally{signal.removeEventListener('abort',abort);this.#waits.delete(controller);}
 }
 async setTemperature(name:string,target:number,wait:boolean,signal:AbortSignal,report:()=>void=()=>{}):Promise<void>{
  const generation=this.#generation;
  await this.setTarget(name,target,signal);
  if(wait&&target!==0){
   signal.throwIfAborted();if(generation!==this.#generation||this.#closed)throw new GCodeError('Heater wait invalidated by shutdown or turn off');
   await this.waitUntilStable(name,signal,report);
  }
 }
 #abortWaits(reason:string):void{for(const wait of this.#waits)wait.abort(new GCodeError(reason));}
 #target(heater:AsyncHeaterRuntime,target:number,signal:AbortSignal):Promise<void>{
  if(target!==0)return heater.setTarget(target,signal);
  const current=this.#zero.get(heater);if(current)return current;
  const pending=heater.setTarget(0,signal);this.#zero.set(heater,pending);
  const clear=()=>{if(this.#zero.get(heater)===pending)this.#zero.delete(heater);};void pending.then(clear,clear);return pending;
 }
 turnOffAll():Promise<void>{
  if(this.#stop)return this.#stop;if(this.#off)return this.#off;
  if(!this.#started)return this.shutdown('Heater turn off before startup completed');
  const deferred=Promise.withResolvers<void>();this.#off=deferred.promise;
  this.#generation++;this.#abortWaits('Temperature wait invalidated by turn off');
  const signal=new AbortController().signal,jobs:Promise<void>[]=[];
  for(const {heater} of this.#entries.values())try{jobs.push(this.#target(heater,0,signal));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(async results=>{
   const errors=results.filter(result=>result.status==='rejected').map(result=>result.reason);
   if(errors.length||this.#closed){
    try{await this.shutdown('One or more heater outputs failed to turn off');}catch(error){errors.push(error);}
    this.#off=undefined;deferred.reject(new AggregateError(errors,'Heater turn off failed'));
   }else{this.#off=undefined;deferred.resolve();}
  });
  return deferred.promise;
 }
 subscribeShutdown(listener:(reason:string)=>void):()=>void{
  if(typeof listener!=='function'||this.#listeners.has(listener)||this.#listeners.size>=64)throw new Error('Invalid heater group shutdown subscription');
  if(this.#closed){listener(this.#reason!);return ()=>{};}
  this.#listeners.add(listener);return ()=>{this.#listeners.delete(listener);};
 }
 shutdown(reason='Heater registry stopped'):Promise<void>{
  if(this.#stop)return this.#stop;
  const deferred=Promise.withResolvers<void>();this.#stop=deferred.promise;
  this.#closed=true;this.#generation++;this.#reason=reason;this.#abortWaits(reason);
  for(const detach of this.#detachers)try{detach();}catch(error){this.#errors.push(error);}this.#detachers.clear();
  const jobs:Promise<void>[]=[];
  for(const {heater} of this.#entries.values())try{jobs.push(heater.shutdown(reason));}catch(error){this.#errors.push(error);}
  const listeners=[...this.#listeners];this.#listeners.clear();for(const listener of listeners)try{listener(reason);}catch(error){this.#errors.push(error);}
  const dispatches=[...this.#dispatches];this.#dispatches.clear();
  for(const dispatch of dispatches)try{dispatch.emergencyStop(reason);}catch(error){this.#errors.push(error);}
  void Promise.allSettled(jobs).then(results=>{
   for(const result of results)if(result.status==='rejected')this.#errors.push(result.reason);
   this.#stopSettled=true;
   if(this.#errors.length)deferred.reject(new AggregateError([...this.#errors],'Heater registry shutdown failed'));
   else deferred.resolve();
  });
  return deferred.promise;
 }
 attach(dispatch:GCodeDispatch,standard:StandardHeaterCommands={}):void{
  if(this.#closed||this.#dispatches.size>=64)throw new Error('Heater registry is closed or has too many dispatchers');
  bindHeaterCommands(this,name=>this.#entries.has(name),dispatch,standard);
  this.#dispatches.add(dispatch);
 }
}
