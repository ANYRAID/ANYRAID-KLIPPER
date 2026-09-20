import {compileADC,ADCInput,type CompiledADC} from '../inputs/adc.ts';
import {SerialSession} from '../protocol/serial-session.ts';
import type {PinBinding} from '../protocol/pins.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {ADCTemperature,type TemperatureConverter} from './adc.ts';
export interface TemperatureSink{sample(time:number,temperature:number):void;shutdown(reason:string):void;}
export interface SensorTimer{now():number;schedule(callback:()=>void,seconds:number):()=>void;}
const timer:SensorTimer={now:()=>serialClock.now(),schedule(callback,seconds){const t=setInterval(callback,seconds*1000);return ()=>clearInterval(t);}};
export interface SerialADCConfig<T>{oid:number;pin:PinBinding<T>;minimum:number;maximum:number;currentPrintTime:number;}
/** Single-use ADC temperature wiring. Include plan commands/init in the MCU
 * configuration, start the consumer, then activate. Before activation the most
 * recent valid sample is buffered so an init report cannot race startup. */
export class SerialADCTemperature<T>{
 readonly plan:CompiledADC;
 #session:SerialSession;#sink:TemperatureSink;#input:ADCInput;#converter:ADCTemperature;#printAt:(clock:bigint)=>number;#timer:SensorTimer;
 #detach:()=>void;#cancel:(()=>void)|undefined;#active=false;#closed=false;#fault:unknown;#stopError:unknown;
 #started=0;#lastNow=0;#receive=0;#sample:readonly [number,number]|undefined;
 constructor(session:SerialSession,chip:T,config:SerialADCConfig<T>,converter:TemperatureConverter,clockAt:(time:number)=>bigint,printAt:(clock:bigint)=>number,sink:TemperatureSink,scheduler:SensorTimer=timer){
  session.assertActive();this.#session=session;this.#sink={sample:sink.sample.bind(sink),shutdown:sink.shutdown.bind(sink)};this.#printAt=printAt;this.#timer=scheduler;
  this.#converter=new ADCTemperature(converter,config.minimum,config.maximum,(time,temp)=>this.#reading(time,temp),()=>{});
  const sampling=this.#converter.sampling;this.plan=compileADC(chip,session.dictionary,{...config,...sampling},clockAt);
  this.#input=new ADCInput(this.plan,n=>session.clock.sync.nearestClock(n),printAt,samples=>this.#converter.receive(samples));
  this.#detach=session.subscribeResponse(this.plan.legacy?'analog_in_state oid=%c next_clock=%u value=%hu':'analog_in_state oid=%c next_clock=%u values=%*s',config.oid,{receive:r=>{try{const now=this.#now();if(!Number.isFinite(r.receiveTime)||r.receiveTime>now||now-r.receiveTime>7)throw new Error('ADC report delivery expired');this.#receive=r.receiveTime;this.#input.receive(r.message);}catch(error){this.#fail(error);throw error;}},closed:cause=>this.#close(cause)});
 }
 get status(){return {active:this.#active,closed:this.#closed,fault:this.#fault,stopError:this.#stopError,lastSample:this.#sample?[...this.#sample]:undefined,adc:this.#converter.status};}
 #now():number{const now=this.#timer.now();if(!Number.isFinite(now)||now<0||now<this.#lastNow)throw new Error('ADC host clock is invalid');this.#lastNow=now;return now;}
 #fresh(now:number):void{
  if(!this.#sample){if(now-this.#started>7)throw new Error('ADC first report timed out');return;}
  const time=this.#printAt(this.#session.clock.sync.getClock(now)),sample=this.#sample[0],s=this.#converter.sampling;
  if(!Number.isFinite(time)||time<0||now-this.#receive>7||time-sample>7)throw new Error('ADC temperature report expired');
  // Bound future samples by one report interval plus its sampling window.
  if(sample-time>s.reportTime+s.sampleTime*s.sampleCount)throw new Error('ADC temperature report is in the future');
 }
 #reading(time:number,temp:number):void{this.#sample=[time,temp];this.#fresh(this.#now());if(this.#active)this.#sink.sample(time,temp);}
 activate():void{
  if(this.#active||this.#closed)throw new Error('ADC temperature sensor cannot restart');
  try{this.#session.assertActive();this.#session.configuration;this.#started=this.#now();this.#fresh(this.#started);this.#active=true;if(this.#sample)this.#sink.sample(...this.#sample);if(this.#closed)throw this.#fault;const cancel=this.#timer.schedule(()=>this.#tick(),.25);if(this.#closed){cancel();throw this.#fault;}this.#cancel=cancel;}
  catch(error){this.#fail(error);throw error;}
 }
 #tick():void{if(this.#closed)return;try{this.#session.assertActive();this.#fresh(this.#now());}catch(error){this.#fail(error);}}
 #close(cause:unknown):void{if(this.#closed)return;this.#closed=true;this.#active=false;this.#fault=cause;const errors:unknown[]=[];try{this.#cancel?.();}catch(error){errors.push(error);}try{this.#detach();}catch(error){errors.push(error);}try{this.#sink.shutdown(cause instanceof Error?cause.message:'ADC session stopped');}catch(error){errors.push(error);}if(errors.length){this.#stopError=new AggregateError(errors,'ADC consumer shutdown failed');throw this.#stopError;}}
 #fail(cause:unknown):void{try{this.#close(cause);}catch{/* retained; session must stop even if consumer cleanup fails */}void this.#session.stop(cause).catch(error=>{this.#stopError=this.#stopError===undefined?error:new AggregateError([this.#stopError,error],'ADC consumer and session stop failed');});}
 /** Stopping a required temperature source stops its MCU, not just the reader. */
 async stop(cause:unknown=new Error('ADC temperature sensor stopped')):Promise<void>{this.#fail(cause);await this.#session.stop(cause);if(this.#stopError!==undefined)throw this.#stopError;}
}
