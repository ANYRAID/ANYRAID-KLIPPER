// Heater command registry derived from klippy/extras/heaters.py (GPL-3.0-or-later).
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {fixedDecimal} from '../diagnostics/python-literal.ts';
import {HeaterRuntime} from './runtime.ts';
import {waitForTemperature,waitForTemperatureCondition,type WaitTemperature,type TemperatureWaitTimer} from './temperature-wait.ts';
export interface TemperatureSensor {getTemperature():WaitTemperature;}
interface SensorEntry {sensor:TemperatureSensor;gcodeId?:string;}
export interface StandardHeaterCommands {bed?:string;extruders?:readonly string[];activeExtruder?:()=>string;}
interface Entry {name:string;heater:HeaterRuntime;gcodeId?:string;}
/** Owns configured heater lifecycles. The supplied barrier orders target changes
 * with the motion queue; it must settle when that ordering is established. */
export class PrinterHeaters {
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
  if(this.#started||this.#closed||!name.trim()||name.length>256||/[\u0000-\u001f\u007f]/u.test(name)||this.#sensors.has(name)||this.#sensors.size>=256)throw new Error('Invalid or duplicate temperature sensor');
  if(gcodeId!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  if(gcodeId!==undefined)for(const entry of this.#sensors.values())if(entry.gcodeId===gcodeId)throw new Error('Duplicate temperature G-code id');
  this.#sensors.set(name,{sensor,gcodeId});
 }
 register(name:string,heater:HeaterRuntime,gcodeId?:string):void{
  const short=name.trim().split(/\s+/).at(-1)!;
  if(this.#started||this.#closed||heater.status.stopped||!short||name.length>256||/[\u0000-\u001f\u007f]/u.test(name)||this.#entries.has(short)||this.#entries.size>=64)throw new Error('Invalid or duplicate heater registration');
  if(gcodeId!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  for(const entry of this.#entries.values())if(entry.heater===heater||gcodeId!==undefined&&entry.gcodeId===gcodeId)throw new Error('Duplicate heater or temperature G-code id');
  const detach=heater.subscribeShutdown(reason=>this.shutdown(`Heater '${short}' stopped: ${reason}`));
  try{this.registerSensor(name,heater,gcodeId);this.#entries.set(short,{name,heater,gcodeId});this.#detachers.add(detach);}
  catch(error){detach();throw error;}
 }
 get status(){return {started:this.#started,closed:this.#closed,fault:this.#reason,shutdownErrors:[...new Set([...this.#errors,...Array.from(this.#entries.values(),e=>e.heater.status.shutdownError).filter(error=>error!==undefined)])],available_heaters:Array.from(this.#entries.values(),e=>e.name),available_sensors:[...this.#sensors.keys()]};}
 start():void{
  if(this.#started||this.#closed)throw new Error('Heater registry cannot restart');
  try{for(const entry of this.#entries.values()){entry.heater.start();if(this.#closed)throw new Error('Heater registry stopped during startup');}this.#started=true;}
  catch(error){this.shutdown('Heater registry startup failed');throw error;}
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
  if(!this.#started||this.#closed)throw new GCodeError('Heater registry is not active');
  const generation=this.#generation;
  await this.#barrier(signal);signal.throwIfAborted();
  if(this.#closed||generation!==this.#generation)throw new GCodeError('Heater target invalidated by shutdown or turn off');
  try{entry.heater.setTarget(target);}catch(error){this.shutdown('Heater target command failed');throw error;}
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
  if(!this.#started||this.#closed)throw new GCodeError('Heater registry is not active');
  signal.throwIfAborted();
  if(this.#waits.size>=64)throw new GCodeError('Too many temperature waits');
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});this.#waits.add(controller);
  try{await run(controller.signal);}
  catch(error){if(!controller.signal.aborted)this.shutdown('Temperature wait failed');throw error;}
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
 turnOffAll():void{
  this.#generation++;this.#abortWaits('Temperature wait invalidated by turn off');
  const errors:unknown[]=[];
  for(const {heater} of this.#entries.values()){
   try{
    if(heater.status.started&&!heater.status.stopped)heater.setTarget(0);
    else if(heater.status.shutdownError!==undefined)errors.push(heater.status.shutdownError);
   }catch(error){errors.push(error);}
  }
  if(errors.length){this.shutdown('One or more heater outputs failed to turn off');throw new AggregateError([...errors,...this.status.shutdownErrors],'Heater turn off failed');}
 }
 shutdown(reason='Heater registry stopped'):void{
  if(this.#closed)return;this.#closed=true;this.#generation++;this.#reason=reason;this.#abortWaits(reason);
  for(const detach of this.#detachers)try{detach();}catch(error){this.#errors.push(error);}this.#detachers.clear();
  for(const {heater} of this.#entries.values()){
   try{heater.shutdown(reason);}catch(error){this.#errors.push(error);}
  }
  const dispatches=[...this.#dispatches];this.#dispatches.clear();
  for(const dispatch of dispatches)try{dispatch.emergencyStop(reason);}catch(error){this.#errors.push(error);}
 }
 attach(dispatch:GCodeDispatch,standard:StandardHeaterCommands={}):void{
  if(this.#closed||this.#dispatches.size>=64)throw new Error('Heater registry is closed or has too many dispatchers');
  const bed=standard.bed,extruders=standard.extruders?[...standard.extruders]:undefined,active=standard.activeExtruder;
  if(bed!==undefined&&!this.#entries.has(bed))throw new Error('Bed heater is not registered');
  if(extruders&&(extruders.length===0||extruders.length>64||new Set(extruders).size!==extruders.length||extruders.some(name=>!this.#entries.has(name))||extruders.length>1&&typeof active!=='function'))throw new Error('Invalid extruder heater mapping');
  const extra=[...(bed!==undefined?['M140','M190']:[]),...(extruders?['M104','M109']:[])];
  for(const name of ['M105','SET_HEATER_TEMPERATURE','TURN_OFF_HEATERS','TEMPERATURE_WAIT',...extra])if(dispatch.hasCommand(name))throw new Error(`Duplicate command '${name}'`);
  const temperature=(raw:string|undefined)=>{const text=raw??'0';if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)||!Number.isFinite(Number(text)))throw new GCodeError('Invalid heater temperature');return Number(text);};
  if(bed!==undefined)for(const name of ['M140','M190'])dispatch.register(name,command=>this.setTemperature(bed,temperature(command.params.S),name==='M190',command.signal,()=>command.respondRaw(this.report())));
  if(extruders)for(const name of ['M104','M109'])dispatch.register(name,command=>{
   const target=temperature(command.params.S),raw=command.params.T;let selected:string|undefined;
   if(raw!==undefined){
    if(!/^[+-]?\d+$/.test(raw)||!Number.isSafeInteger(Number(raw))||Number(raw)<0)throw new GCodeError('Invalid extruder index');
    selected=extruders[Number(raw)];if(selected===undefined){if(target<=0)return;throw new GCodeError('Extruder not configured');}
   }else{selected=active?active():extruders[0];if(!extruders.includes(selected))throw new GCodeError('Active extruder is not configured');}
   return this.setTemperature(selected,target,name==='M109',command.signal,()=>command.respondRaw(this.report()));
  });
  dispatch.register('M105',command=>{const message=this.report();if(!command.ack(message))command.respondRaw(message);},{whenNotReady:true});
  dispatch.register('SET_HEATER_TEMPERATURE',command=>{
   const name=command.params.HEATER;if(name===undefined)throw new GCodeError('Missing HEATER');
   const raw=command.params.TARGET??'0';
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))throw new GCodeError('Invalid TARGET');
   return this.setTarget(name,Number(raw),command.signal);
  });
  dispatch.register('TURN_OFF_HEATERS',()=>this.turnOffAll());
  dispatch.register('TEMPERATURE_WAIT',command=>{
   const name=command.params.SENSOR;if(name===undefined)throw new GCodeError('Missing SENSOR');
   const bound=(key:string)=>{const raw=command.params[key];if(raw===undefined)return undefined;if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))throw new GCodeError(`Invalid ${key}`);return Number(raw);};
   return this.wait(name,bound('MINIMUM'),bound('MAXIMUM'),command.signal,()=>command.respondRaw(this.report()));
  });
  this.#dispatches.add(dispatch);
 }
}
