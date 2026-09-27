import {SerialSession,type TimedCommandQueue} from '../protocol/serial-session.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {EndstopProtocol} from '../inputs/endstop.ts';
import {TriggerSyncProtocol,triggerReason} from '../inputs/trsync.ts';
import {observeRetirement} from '../motion/retired.ts';
import type {BLTouchDevicePort} from './bltouch-device.ts';
type Verification=Parameters<BLTouchDevicePort['verifyState']>[0];
/** A dedicated trsync OID, never registered to any stepper. The enclosing
 * probe owner must exclude homing/sampling on this endstop for the entire call.
 * MCU timeout provides normal no-hit evidence; transport timeout is a fault. */
export class EndstopVerification {
 #session:SerialSession;#queue:TimedCommandQueue;#endstop:EndstopProtocol;#trigger:TriggerSyncProtocol;
 #clockAt:(time:number)=>bigint;#waitUntil:(time:number,signal:AbortSignal)=>Promise<void>;#busy=false;#failed=false;
 constructor(session:SerialSession,queue:TimedCommandQueue,endstop:EndstopProtocol,trigger:TriggerSyncProtocol,clockAt:(time:number)=>bigint,waitUntil:(time:number,signal:AbortSignal)=>Promise<void>){
  session.assertCommandQueue(queue);endstop.assertDictionary(session.dictionary);trigger.assertDictionary(session.dictionary);if(endstop.oid===trigger.oid)throw new Error('Verification OIDs overlap');
  this.#session=session;this.#queue=queue;this.#endstop=endstop;this.#trigger=trigger;this.#clockAt=clockAt;this.#waitUntil=waitUntil;
 }
 get status(){return {busy:this.#busy,failed:this.#failed};}
 async verify(options:Verification,signal:AbortSignal,timeoutMs=5000):Promise<boolean>{
  signal.throwIfAborted();if(this.#busy||this.#failed)throw new Error('Endstop verification unavailable');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isFinite(options.until)||options.until<=options.time)throw new RangeError('Invalid verification deadline');
  const sampling=this.#endstop.home({printTime:options.time,sampleTime:options.sampleTime,sampleCount:options.sampleCount,restTime:options.restTime,trsyncOid:this.#trigger.oid,triggered:options.triggered},this.#clockAt),end=this.#clockAt(options.until),now=this.#session.clock.sync.getClock(serialClock.now());
  if(typeof end!=='bigint'||end<=sampling.reqClock||end-now>0x7fffffffn||sampling.reqClock<=now||end>0x7fffffffffffffffn)throw new RangeError('Verification window is expired or unrepresentable');
  const controller=new AbortController(),s=AbortSignal.any([signal,controller.signal]),timer=setTimeout(()=>controller.abort(new Error('Endstop verification timed out')),timeoutMs);
  this.#busy=true;let stopping:Promise<void>|undefined;
  const stop=(cause:unknown)=>{this.#failed=true;return stopping??=this.#session.stop(cause);},abort=()=>{void stop(s.reason).catch(()=>{});};s.addEventListener('abort',abort,{once:true});
  const wait=async<T>(p:Promise<T>):Promise<T>=>{let result!:T;await observeRetirement(p.then(v=>{result=v;}),s);s.throwIfAborted();this.#session.assertActive();return result;};
  try{
   const d=this.#session.dictionary,oid=this.#trigger.oid;
   // No periodic reporter or host-renewed watchdog: this bounded MCU timer
   // ends a stationary sensor test, with no stepper_stop_on_trigger commands.
   await wait(this.#queue.send(d.encode('trsync_start',{oid,report_clock:0,report_ticks:0,expire_reason:triggerReason.pastEndTime}),0n,sampling.reqClock,s));
   await wait(this.#queue.send(d.encode('trsync_set_timeout',{oid,clock:Number(BigInt.asUintN(32,end))}),0n,sampling.reqClock,s));
   if(sampling.reqClock<=this.#session.clock.sync.getClock(serialClock.now()))throw new Error('Verification arm clock expired');
   await wait(this.#queue.send(sampling.payload,0n,sampling.reqClock,s));
   await wait(this.#waitUntil(options.until,s));
   if(this.#session.clock.sync.getClock(serialClock.now())<end)throw new Error('Verification wait ended before MCU deadline');
   await wait(this.#queue.send(this.#endstop.stop(),0n,0n,s));
   const tr=await wait(this.#session.queryOnQueue(this.#queue,this.#trigger.trigger(triggerReason.hostRequest),'trsync_state',s,{oid})),state=this.#trigger.decode(tr.message);
   if(!state||state.canTrigger||state.failure||state.reason!==triggerReason.endstopHit&&state.reason!==triggerReason.pastEndTime)throw new Error('MCU did not confirm verification outcome');
   const reply=await wait(this.#session.queryOnQueue(this.#queue,this.#endstop.query(),'endstop_state',s,{oid:this.#endstop.oid})),sensor=this.#endstop.decode(reply.message);
   if(!sensor||sensor.homing)throw new Error('Verification sampling did not stop');
   if(state.reason===triggerReason.pastEndTime)return false;
   const hit=this.#endstop.hitClock(sensor,sampling,c=>this.#session.clock.sync.nearestClock(c));
   if(hit>end||hit>this.#session.clock.sync.getClock(reply.receiveTime))throw new Error('Verification hit outside window');
   return true;
  }catch(error){try{await stop(error);}catch(cleanup){throw new AggregateError([error,cleanup],'Endstop verification and stop failed');}throw error;}
  finally{clearTimeout(timer);s.removeEventListener('abort',abort);this.#busy=false;}
 }
}
