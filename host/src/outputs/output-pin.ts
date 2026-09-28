import {normalizeOutputPinValue,type OutputPinSettings} from '../config/output-pin.ts';
import {StopNotice} from '../runtime/stop-notice.ts';

export interface PinOutput {
 reset(signal:AbortSignal):Promise<void>;
 setValue(time:number,value:number,signal:AbortSignal):Promise<void>;
 align(time:number):number;
 stop(cause:unknown):Promise<void>;
}
/** Bounded, ordered requests in the owning MCU's print-time domain.
 * The motion owner supplies endpoint times and flush horizons. ACKed values
 * describe scheduled output, not physical feedback from the pin. */
export class ScheduledOutputPin {
 #output:PinOutput;#settings:OutputPinSettings;#interval:number;#capacity:number;#earlySlack:number;
 #queue:{time:number;value:number}[]=[];#next=0;#lastRequest=0;#horizon=0;#value:number;
 #phase:'idle'|'ready'|'stopped'='idle';#busy=false;#abort=new AbortController();
 #stop:Promise<void>|undefined;#fault:unknown;#notice=new StopNotice();
 constructor(output:PinOutput,settings:OutputPinSettings,minimumScheduleTime:number,capacity=1024,earlySlack=0){
  if(!Number.isFinite(minimumScheduleTime)||minimumScheduleTime<=0||!Number.isInteger(capacity)||capacity<1||capacity>65536||!Number.isFinite(earlySlack)||earlySlack<0||earlySlack>minimumScheduleTime)throw new RangeError('Invalid output pin scheduling limits');
  for(const value of [settings.initialValue,settings.shutdownValue]){
   if(!Number.isFinite(value)||value<0||value>1||!settings.pwm&&value!==0&&value!==1)throw new RangeError('Invalid normalized output pin default');
  }
  this.#output=output;this.#settings={...settings};this.#interval=minimumScheduleTime;this.#capacity=capacity;this.#earlySlack=earlySlack;this.#value=settings.shutdownValue;
 }
 get capacity(){return this.#capacity;}
 get status(){return {phase:this.#phase,busy:this.#busy,value:this.#value,pending:this.#queue.length,
  nextTime:this.#queue.length?Math.max(this.#queue[0].time,this.#next):null,fault:this.#fault,observerErrors:this.#notice.errors};}
 subscribeStop(listener:(cause:unknown)=>void){return this.#notice.subscribe(listener);}
 validateValue(value:number):void{normalizeOutputPinValue(this.#settings,value);}
 #check(signal:AbortSignal){signal.throwIfAborted();if(this.#phase==='stopped')throw new Error('Output pin stopped',{cause:this.#fault});}
 #after(time:number){const next=time+this.#interval;if(!Number.isFinite(next)||next<=time)throw new RangeError('Output pin schedule time overflow');return next;}
 async start(futureTime:()=>number,signal:AbortSignal):Promise<void>{
  if(this.#phase!=='idle'||this.#busy)throw new Error('Output pin cannot restart');
  this.#check(signal);this.#busy=true;const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   await this.#output.reset(local);this.#check(local);
   if(this.#settings.initialValue!==this.#value){
    const requested=futureTime(),time=this.#output.align(requested);
    if(!Number.isFinite(requested)||requested<0||!Number.isFinite(time)||time<requested-this.#earlySlack||time<0)throw new RangeError('Invalid output pin startup time');
    const next=this.#after(Math.max(time,requested));await this.#output.setValue(time,this.#settings.initialValue,local);this.#check(local);
    this.#value=this.#settings.initialValue;this.#next=next;
   }
   this.#phase='ready';
  }catch(error){await this.#fail(error);}finally{this.#busy=false;}
 }
 enqueue(time:number,value:number):void{
  if(this.#phase!=='ready'||this.#busy)throw new Error('Output pin not ready or busy');
  const normalized=normalizeOutputPinValue(this.#settings,value);
  if(!Number.isFinite(time)||time<Math.max(this.#lastRequest,this.#horizon))throw new RangeError('Invalid output pin request time');
  if(this.#queue.length>=this.#capacity)throw new Error('Output pin request capacity exceeded');
  this.#queue.push({time,value:normalized});this.#lastRequest=time;
 }
 async flush(horizon:number,signal:AbortSignal):Promise<void>{
  if(this.#phase!=='ready'||this.#busy)throw new Error('Output pin not ready or busy');
  if(!Number.isFinite(horizon)||horizon<this.#horizon)throw new RangeError('Invalid output pin flush horizon');
  this.#check(signal);this.#busy=true;const local=AbortSignal.any([signal,this.#abort.signal]);
  try{
   let remaining=this.#capacity*3+1;
   while(this.#queue.length){
    if(remaining--===0)throw new Error('Output pin alignment did not converge');
    this.#check(local);let time=Math.max(this.#queue[0].time,this.#next);if(time>horizon)break;
    let pos=0;while(pos+1<this.#queue.length&&this.#queue[pos+1].time<=time)pos++;
    const value=this.#queue[pos].value;
    if(value===this.#value){this.#queue.splice(0,pos+1);continue;}
    const aligned=this.#output.align(time);
    if(!Number.isFinite(aligned)||aligned<time-this.#earlySlack||aligned<0)throw new RangeError('Output pin alignment regressed');
    if(aligned>time){this.#next=aligned;continue;}
    const next=this.#after(time);time=aligned;
    await this.#output.setValue(time,value,local);this.#check(local);
    this.#value=value;this.#next=next;this.#queue.splice(0,pos+1);
   }
   this.#horizon=horizon;
  }catch(error){await this.#fail(error);}finally{this.#busy=false;}
 }
 /** Motion admission must be fenced before cancelling the old generation. */
 async resetToDefault(signal:AbortSignal):Promise<void>{
  if(this.#phase!=='ready'||this.#busy)throw new Error('Output pin not ready or busy');
  this.#check(signal);this.#busy=true;const local=AbortSignal.any([signal,this.#abort.signal]);
  try{await this.#output.reset(local);this.#check(local);this.#queue=[];this.#next=this.#lastRequest=this.#horizon=0;this.#value=this.#settings.shutdownValue;}
  catch(error){await this.#fail(error);}finally{this.#busy=false;}
 }
 async #fail(error:unknown):Promise<never>{try{await this.stop(error);}catch(stopError){throw new AggregateError([error,stopError],'Output pin operation and stop failed');}throw error;}
 stop(cause:unknown=new Error('Output pin stopped')):Promise<void>{
  if(this.#stop)return this.#stop;const done=Promise.withResolvers<void>();this.#stop=done.promise;
  this.#phase='stopped';this.#fault=cause;this.#queue=[];this.#abort.abort(cause);
  try{Promise.resolve(this.#output.stop(cause)).then(done.resolve,done.reject);}catch(error){done.reject(error);}
  this.#notice.emit(cause);return done.promise;
 }
}
