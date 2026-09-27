// Device lifecycle derived from klippy/extras/bltouch.py (GPL-3.0-or-later).
import {BLTouchCommandQueue,type BLTouchCommandPort,type BLTouchCommand} from './bltouch-command.ts';
import {observeRetirement} from '../motion/retired.ts';
export interface BLTouchSettings {
 pinMoveTime:number;stowOnEachSample:boolean;touchMode:boolean;
 pinUpNotTriggered:boolean;pinUpTouchTriggered:boolean;outputMode:'5V'|'OD'|null;
}
export interface BLTouchDevicePort extends BLTouchCommandPort {
 /** Same print-time domain as PWM; estimated time must belong to its MCU. */
 estimatedPrintTime():number;
 motionPrintTime():number;
 waitUntil(time:number,signal:AbortSignal):Promise<void>;
 /** Independent endstop sampling, without enabling motion. False means a
  * completed verification window with no hit; transport failures must reject. */
 verifyState(options:{time:number;until:number;triggered:boolean;sampleTime:number;sampleCount:number;restTime:number},signal:AbortSignal):Promise<boolean>;
}
export type BLTouchSample=<R>(seek:(signal:AbortSignal)=>Promise<R>)=>Promise<R>;
/** The outer motion owner retains exclusive hardware ownership throughout
 * session(). Port.stop must stop both motion and PWM, not merely clear duty. */
export class BLTouchDevice {
 #port:BLTouchDevicePort;#commands:BLTouchCommandQueue;#settings:Readonly<BLTouchSettings>;
 #phase:'new'|'initializing'|'idle'|'session'|'failed'='new';#deployed=false;#busySample=false;#nextTest=0;
 #abort=new AbortController();#stopping:Promise<void>|undefined;
 constructor(port:BLTouchDevicePort,settings:BLTouchSettings){
  if(!Number.isFinite(settings.pinMoveTime)||settings.pinMoveTime<=0||![settings.stowOnEachSample,settings.touchMode,settings.pinUpNotTriggered,settings.pinUpTouchTriggered].every(v=>typeof v==='boolean')||![null,'5V','OD'].includes(settings.outputMode))throw new RangeError('Invalid BLTouch device settings');
  this.#port=port;this.#commands=new BLTouchCommandQueue(port);this.#settings=Object.freeze({...settings});
 }
 get status(){return {phase:this.#phase,deployed:this.#deployed,sampleActive:this.#busySample,nextSensorTest:this.#nextTest,commands:this.#commands.status};}
 stop(cause:unknown):Promise<void>{
  if(this.#stopping)return this.#stopping;
  this.#phase='failed';this.#stopping=this.#commands.stop(cause);this.#abort.abort(cause);return this.#stopping;
 }
 #check(s:AbortSignal){s.throwIfAborted();if(this.#phase==='failed')throw new Error('BLTouch device stopped');}
 async #wait<T>(work:Promise<T>,s:AbortSignal):Promise<T>{let value!:T;await observeRetirement(work.then(v=>{value=v;}),s);this.#check(s);return value;}
 #time(value:number){if(!Number.isFinite(value)||value<0)throw new RangeError('Invalid BLTouch time');return value;}
 #earliest(){return Math.max(this.#time(this.#port.motionPrintTime()),this.#time(this.#port.estimatedPrintTime())+.1);}
 async #send(command:BLTouchCommand,s:AbortSignal,duration=.1,extraLead=0){this.#check(s);return this.#wait(this.#commands.send(command,this.#earliest()+extraLead,s,duration),s);}
 async #sync(s:AbortSignal){await this.#wait(this.#port.waitUntil(Math.max(this.#commands.status.nextCommandTime,this.#time(this.#port.motionPrintTime())),s),s);}
 async #verify(triggered:boolean,s:AbortSignal){
  const time=this.#commands.status.actionEndTime,until=time+.1;if(until<=time)throw new RangeError('Unrepresentable BLTouch verification window');
  return this.#wait(this.#port.verifyState({time,until,triggered,sampleTime:.000015,sampleCount:4,restTime:.001},s),s);
 }
 async #raise(s:AbortSignal,extraLead=0){
  if(!this.#settings.pinUpNotTriggered){await this.#send('reset',s,.1,extraLead);extraLead=0;}
  await this.#send('pin_up',s,this.#settings.pinMoveTime,extraLead);
  if(this.#settings.pinUpNotTriggered)for(let retry=0;;retry++){
   if(await this.#verify(false,s))break;
   if(retry===2)throw new Error('BLTouch failed to raise probe');
   await this.#send('reset',s,1);await this.#send('pin_up',s,this.#settings.pinMoveTime);
  }
  await this.#sync(s);this.#deployed=false;
 }
 async #lower(s:AbortSignal){
  if(this.#settings.pinUpTouchTriggered){
   const time=this.#time(this.#port.motionPrintTime());
   if(time>=this.#nextTest)for(let retry=0;;retry++){
    await this.#send('pin_up',s,this.#settings.pinMoveTime);await this.#send('touch_mode',s);
    const verified=await this.#verify(true,s);await this.#sync(s);
    if(verified)break;if(retry===2)throw new Error('BLTouch failed to verify sensor state');await this.#send('reset',s,1);
   }
   // Original sensor test timeout is extended on each consecutive use.
   this.#nextTest=time+300;if(!Number.isFinite(this.#nextTest)||this.#nextTest<=time)throw new RangeError('Unrepresentable BLTouch test timeout');
  }
  await this.#send('pin_down',s,this.#settings.pinMoveTime);if(this.#settings.touchMode)await this.#send('touch_mode',s);
  await this.#sync(s);this.#deployed=true;
 }
 async #owned<T>(signal:AbortSignal,work:(s:AbortSignal)=>Promise<T>):Promise<T>{
  const s=AbortSignal.any([signal,this.#abort.signal]),abort=()=>{void this.stop(s.reason).catch(()=>{});};s.addEventListener('abort',abort,{once:true});
  try{this.#check(s);return await work(s);}catch(error){try{await this.stop(error);}catch(stop){throw new AggregateError([error,stop],'BLTouch lifecycle and stop failed');}throw error;}finally{s.removeEventListener('abort',abort);}
 }
 async initialize(signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();if(this.#phase!=='new')throw new Error('BLTouch initialization requires a new device');this.#phase='initializing';
  await this.#owned(signal,async s=>{if(this.#settings.outputMode)await this.#send(this.#settings.outputMode==='5V'?'set_5V_output_mode':'set_OD_output_mode',s,.1,.2);await this.#raise(s,this.#settings.outputMode?0:.2);this.#check(s);this.#phase='idle';});
 }
 async session<T>(run:(sample:BLTouchSample,signal:AbortSignal)=>Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();if(this.#phase!=='idle')throw new Error('BLTouch session requires an idle initialized device');this.#phase='session';
  return this.#owned(signal,async s=>{
   let active=true;
   const sample:BLTouchSample=async seek=>{
    this.#check(s);if(!active||this.#busySample)throw new Error('BLTouch sample ownership conflict');this.#busySample=true;
    try{if(!this.#deployed)await this.#lower(s);const value=await this.#wait(seek(s),s);if(this.#settings.stowOnEachSample)await this.#raise(s);return value;}
    catch(error){try{await this.stop(error);}catch(stop){throw new AggregateError([error,stop],'BLTouch sample and stop failed');}throw error;}finally{this.#busySample=false;}
   };
   let value:T;try{value=await this.#wait(run(sample,s),s);}finally{active=false;}
   if(this.#busySample)throw new Error('BLTouch session returned with an active sample');
   this.#check(s);if(this.#deployed)await this.#raise(s);this.#check(s);this.#phase='idle';return value;
  });
 }
}
