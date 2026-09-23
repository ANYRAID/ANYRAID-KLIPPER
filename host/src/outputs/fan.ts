// Cooling fan and request coalescing from klippy/extras/fan.py and
// output_pin.py. GPL-3.0-or-later.
import {StopNotice} from '../runtime/stop-notice.ts';
import {GCodeDispatch,GCodeError} from '../gcode/dispatch.ts';
/** The supplied callback must attach a request to the admitted motion boundary,
 * not execute it immediately or drain all motion. Only one part fan is mapped. */
export function bindCoolingFanCommands(dispatch:GCodeDispatch,queueAtBoundary:(value:number,signal:AbortSignal)=>void|Promise<void>):void{
 if(typeof queueAtBoundary!=='function'||dispatch.hasCommand('M106')||dispatch.hasCommand('M107'))throw new Error('Invalid or duplicate cooling fan command binding');
 for(const name of ['M106','M107'])dispatch.register(name,c=>{
  if(c.params.P!==undefined&&!/^\+?0+$/.test(c.params.P))throw new GCodeError('Cooling fan index is not configured');
  const text=name==='M107'?'0':c.params.S??'255';
  if(!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)||!Number.isFinite(Number(text)))throw new GCodeError('Invalid cooling fan speed');
  return queueAtBoundary(Number(text)/255,c.signal);
 });
}
export interface FanOutput {
 readonly configuration:Readonly<{initialPower:number;defaultPower:number;maximumDuration:number}>;
 /** Confirm generation reset and settle all previously accepted writes. */
 reset(signal:AbortSignal):Promise<void>;
 setPWM(time:number,power:number,signal:AbortSignal):Promise<void>;
 /** Confirm independent device stop and settle accepted host writes. */
 stop(cause:unknown):Promise<void>;
}
export interface FanConfig {maxPower?:number;kickStartTime?:number;offBelow?:number;minimumScheduleTime:number;capacity?:number;}
/** Part-cooling only: zero start/shutdown and no watchdog. Heater/chamber fans
 * need different thermal ownership. Motion owns request timestamps and flush
 * horizons; queueing a command must not force a motion drain. */
export class ScheduledCoolingFan {
 #output:FanOutput;#enable:FanOutput|undefined;#max:number;#kick:number;#below:number;#interval:number;#capacity:number;
 #queue:{time:number;value:number}[]=[];#next=0;#lastRequest=0;#horizon=0;#value=0;#requested=0;
 #phase:'idle'|'ready'|'stopped'='idle';#busy=false;#abort=new AbortController();#stop:Promise<void>|undefined;#fault:unknown;#notice=new StopNotice();
 constructor(output:FanOutput,config:FanConfig,enable?:FanOutput){
  const max=config.maxPower??1,kick=config.kickStartTime??.1,below=config.offBelow??0,interval=config.minimumScheduleTime,capacity=config.capacity??1024;
  if(!Number.isFinite(max)||max<=0||max>1||!Number.isFinite(kick)||kick<0||!Number.isFinite(below)||below<0||below>1||!Number.isFinite(interval)||interval<=0||!Number.isInteger(capacity)||capacity<1||capacity>65536||enable===output)throw new RangeError('Invalid cooling fan configuration');
  for(const item of [output,...enable?[enable]:[]])if(item.configuration.initialPower!==0||item.configuration.defaultPower!==0||item.configuration.maximumDuration!==0)throw new Error('Cooling fan requires zero defaults without a watchdog');
  this.#output=output;this.#enable=enable;this.#max=max;this.#kick=kick;this.#below=below;this.#interval=interval;this.#capacity=capacity;
 }
 get status(){return {phase:this.#phase,busy:this.#busy,speed:this.#requested,scheduledPower:this.#value,pending:this.#queue.length,nextTime:this.#queue.length?Math.max(this.#queue[0].time,this.#next):null,fault:this.#fault,observerErrors:this.#notice.errors};}
 get capacity():number{return this.#capacity;}
 subscribeStop(listener:(cause:unknown)=>void):()=>void{return this.#notice.subscribe(listener);}
 #check(signal:AbortSignal){signal.throwIfAborted();if(this.#phase==='stopped')throw new Error('Cooling fan stopped',{cause:this.#fault});}
 async #reset(signal:AbortSignal){
  if(this.#busy)throw new Error('Cooling fan is busy');this.#check(signal);this.#busy=true;
  const local=AbortSignal.any([signal,this.#abort.signal]);
  try{await Promise.all([this.#output,...this.#enable?[this.#enable]:[]].map(o=>o.reset(local)));this.#check(local);this.#queue=[];this.#next=this.#lastRequest=this.#horizon=this.#value=this.#requested=0;this.#phase='ready';}
  catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Cooling fan reset and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 start(signal:AbortSignal):Promise<void>{if(this.#phase!=='idle')return Promise.reject(new Error('Cooling fan cannot restart'));return this.#reset(signal);}
 /** Call after motion/flush admission is fenced. Cancels queued future duty by
  * generation reset; completion is an MCU ACK, not electrical pin feedback. */
 off(signal:AbortSignal):Promise<void>{if(this.#phase!=='ready')return Promise.reject(new Error('Cooling fan not ready'));return this.#reset(signal);}
 enqueue(time:number,value:number):void{
  if(this.#phase!=='ready'||this.#busy)throw new Error('Cooling fan not ready or busy');
  if(!Number.isFinite(time)||time<Math.max(this.#lastRequest,this.#horizon)||!Number.isFinite(value)||value<0)throw new RangeError('Invalid cooling fan request');
  if(this.#queue.length>=this.#capacity)throw new Error('Cooling fan request capacity exceeded');
  this.#queue.push({time,value});this.#lastRequest=time;
 }
 async flush(horizon:number,signal:AbortSignal):Promise<void>{
  if(this.#phase!=='ready'||this.#busy)throw new Error('Cooling fan not ready or busy');
  if(!Number.isFinite(horizon)||horizon<this.#horizon)throw new RangeError('Invalid cooling fan flush horizon');
  this.#check(signal);this.#busy=true;const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   while(this.#queue.length){
    this.#check(local);const time=Math.max(this.#queue[0].time,this.#next);if(time>horizon)break;
    let pos=0;while(pos+1<this.#queue.length&&this.#queue[pos+1].time<=time)pos++;
    let value=this.#queue[pos].value;if(value<this.#below)value=0;value=Math.max(0,Math.min(this.#max,value*this.#max));
    if(value===this.#value){this.#queue.splice(0,pos+1);continue;}
    const repeat=value!==0&&this.#kick!==0&&(this.#value===0||value-this.#value>.5),next=time+Math.max(this.#interval,repeat?this.#kick:0);
    if(!Number.isFinite(next)||next<=time)throw new RangeError('Cooling fan schedule time overflow');
    if(this.#enable&&(value===0||this.#value===0))await this.#enable.setPWM(time,value>0?1:0,local);
    this.#check(local);await this.#output.setPWM(time,repeat?this.#max:value,local);this.#check(local);
    this.#requested=value;this.#value=repeat?this.#max:value;this.#next=next;this.#queue.splice(0,pos+(repeat?0:1));
   }
   this.#horizon=horizon;
  }catch(error){try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Cooling fan flush and stop failed');}throw error;}
  finally{this.#busy=false;}
 }
 stop(cause:unknown=new Error('Cooling fan stopped')):Promise<void>{
  if(this.#stop)return this.#stop;const done=Promise.withResolvers<void>();this.#stop=done.promise;this.#phase='stopped';this.#fault=cause;this.#queue=[];this.#abort.abort(cause);
  const jobs:Promise<void>[]=[];for(const output of [this.#output,...this.#enable?[this.#enable]:[]])try{jobs.push(output.stop(cause));}catch(error){jobs.push(Promise.reject(error));}
  void Promise.allSettled(jobs).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)done.reject(new AggregateError(errors,'Cooling fan output stop failed'));else done.resolve();});this.#notice.emit(cause);return this.#stop;
 }
}
