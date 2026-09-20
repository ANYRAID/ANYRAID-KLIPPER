// Heater command registry derived from klippy/extras/heaters.py (GPL-3.0-or-later).
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
import {fixedDecimal} from '../diagnostics/python-literal.ts';
import {HeaterRuntime} from './runtime.ts';
interface Entry {name:string;heater:HeaterRuntime;gcodeId?:string;}
/** Owns configured heater lifecycles. The supplied barrier orders target changes
 * with the motion queue; it must settle when that ordering is established. */
export class PrinterHeaters {
 #entries=new Map<string,Entry>();#started=false;#closed=false;#generation=0;
 #reason:string|undefined;#errors:unknown[]=[];#barrier:(signal:AbortSignal)=>void|Promise<void>;
 constructor(beforeTarget:(signal:AbortSignal)=>void|Promise<void>){this.#barrier=beforeTarget;}
 register(name:string,heater:HeaterRuntime,gcodeId?:string):void{
  const short=name.trim().split(/\s+/).at(-1)!;
  if(this.#started||this.#closed||!short||name.length>256||/[\u0000-\u001f\u007f]/u.test(name)||this.#entries.has(short)||this.#entries.size>=64)throw new Error('Invalid or duplicate heater registration');
  if(gcodeId!==undefined&&!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(gcodeId))throw new Error('Invalid temperature G-code id');
  for(const entry of this.#entries.values())if(entry.heater===heater||gcodeId!==undefined&&entry.gcodeId===gcodeId)throw new Error('Duplicate heater or temperature G-code id');
  this.#entries.set(short,{name,heater,gcodeId});
 }
 get status(){return {started:this.#started,closed:this.#closed,fault:this.#reason,shutdownErrors:[...this.#errors],available_heaters:Array.from(this.#entries.values(),e=>e.name)};}
 start():void{
  if(this.#started||this.#closed)throw new Error('Heater registry cannot restart');
  try{for(const entry of this.#entries.values())entry.heater.start();this.#started=true;}
  catch(error){this.shutdown('Heater registry startup failed');throw error;}
 }
 report():string{
  if(!this.#started)return 'T:0';
  const entries=Array.from(this.#entries.values()).filter(e=>e.gcodeId!==undefined).sort((a,b)=>a.gcodeId!<b.gcodeId!?-1:1);
  return entries.map(e=>{const state=e.heater.getTemperature();return `${e.gcodeId}:${fixedDecimal(state.temperature,1)} /${fixedDecimal(state.target,1)}`;}).join(' ')||'T:0';
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
 turnOffAll():void{
  this.#generation++;
  const errors:unknown[]=[];
  for(const {heater} of this.#entries.values()){
   try{
    if(heater.status.started&&!heater.status.stopped)heater.setTarget(0);
    else if(heater.status.shutdownError!==undefined)errors.push(heater.status.shutdownError);
   }catch(error){errors.push(error);}
  }
  if(errors.length){this.shutdown('One or more heater outputs failed to turn off');throw new AggregateError([...errors,...this.#errors],'Heater turn off failed');}
 }
 shutdown(reason='Heater registry stopped'):void{
  if(this.#closed)return;this.#closed=true;this.#generation++;this.#reason=reason;
  for(const {heater} of this.#entries.values()){
   try{heater.shutdown(reason);if(heater.status.shutdownError!==undefined)this.#errors.push(heater.status.shutdownError);}catch(error){this.#errors.push(error);}
  }
 }
 attach(dispatch:GCodeDispatch):void{
  for(const name of ['M105','SET_HEATER_TEMPERATURE','TURN_OFF_HEATERS'])if(dispatch.hasCommand(name))throw new Error(`Duplicate command '${name}'`);
  dispatch.register('M105',command=>{const message=this.report();if(!command.ack(message))command.respondRaw(message);},{whenNotReady:true});
  dispatch.register('SET_HEATER_TEMPERATURE',command=>{
   const name=command.params.HEATER;if(name===undefined)throw new GCodeError('Missing HEATER');
   const raw=command.params.TARGET??'0';
   if(!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))throw new GCodeError('Invalid TARGET');
   return this.setTarget(name,Number(raw),command.signal);
  });
  dispatch.register('TURN_OFF_HEATERS',()=>this.turnOffAll());
 }
}
