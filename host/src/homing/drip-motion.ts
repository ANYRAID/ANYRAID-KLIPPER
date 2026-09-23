// Bounded homing progression corresponding to motion_queuing.drip_update_time.
// GPL-3.0-or-later.
import {performance} from 'node:perf_hooks';
import {MotionCoordinator} from '../motion/coordinator.ts';
import {observeRetirement} from '../motion/retired.ts';
import type {HomingTriggerSet} from './trigger-set.ts';
export interface DripClock {
 /** Conservative current print time across every participating MCU. Must check
  * clock health on each call; host wall time alone is not a motion clock. */
 estimatedPrintTime():number;
 /** Exclusive synchronous maintenance, bounded by the next drip window.
  * May generate a calibration prefix, but must not publish or await IO. */
 prepareWindow?(until:number):void;
}
export interface DripResult {readonly reason:'triggered'|'exhausted';readonly generatedUntil:number;}
/** Exclusive, single-use producer for an already queued homing trajectory.
 * Arm the trigger set first. Baseline must already be generated, all source
 * data (including convolution padding) must exist, and background producers
 * must remain fenced. The sink must archive step history for recovery.
 * Success does NOT detach triggers, reset queues or confer homed authority.
 * Even after success, the owner must perform stop/readback and retire this
 * generation before starting any other motion. */
export class DripMotion {
 readonly #coordinator:MotionCoordinator;readonly #triggers:Pick<HomingTriggerSet,'completion'|'status'|'stop'>;readonly #clock:DripClock;
 #started=false;#cleanupPending=false;#cleanupError:unknown;
 constructor(coordinator:MotionCoordinator,triggers:Pick<HomingTriggerSet,'completion'|'status'|'stop'>,clock:DripClock){this.#coordinator=coordinator;this.#triggers=triggers;this.#clock=clock;}
 get status(){return {started:this.#started,cleanupPending:this.#cleanupPending,cleanupError:this.#cleanupError};}
 async run(start:number,end:number,signal:AbortSignal,timeoutMs=60000):Promise<DripResult>{
  if(this.#started)throw new Error('Drip motion is single use');
  const state=this.#coordinator.status;
  if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||end>=1e12||state.generatedTime!==start||state.busy||state.failed||state.retired||Math.ceil((end-start)/.05)>1000000||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new RangeError('Invalid drip motion boundary');
  this.#started=true;
  const local=new AbortController(),combined=AbortSignal.any([signal,local.signal]);
  let completed=false,cleanup:Promise<void>|undefined;
  const stop=(error:unknown)=>{
   if(cleanup)return cleanup;this.#cleanupPending=true;
   cleanup=Promise.allSettled([this.#coordinator.shutdown(error),this.#triggers.stop(error)]).then(results=>{
    const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
    if(errors.length){this.#cleanupError=new AggregateError(errors,'Drip safety cleanup failed');throw this.#cleanupError;}
   }).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;
  };
  const cancelled=()=>{void stop(combined.reason);};combined.addEventListener('abort',cancelled,{once:true});
  const deadline=performance.now()+timeoutMs,timer=setTimeout(()=>local.abort(new Error('Drip motion timed out')),timeoutMs);
  const completion=this.#triggers.completion.then(()=>{completed=true;},error=>{local.abort(error);});
  const check=()=>{
   if(performance.now()>=deadline&&!local.signal.aborted)local.abort(new Error('Drip motion timed out'));
   combined.throwIfAborted();const t=this.#triggers.status,c=this.#coordinator.status;
   if(t.failed)throw t.fault;if(!t.armed||t.released)throw new Error('Drip requires armed trigger ownership');
   if(c.failed)throw c.fault;if(c.retired)throw new Error('Drip generation was retired');
   if(c.busy||c.generatedTime!==until)throw new Error('Drip generation ownership changed');
  };
  const pause=async(seconds:number)=>{
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{await observeRetirement(Promise.race([completion,new Promise<void>(resolve=>{timer=setTimeout(resolve,Math.max(1,Math.ceil(seconds*1000)));})]),combined);}
   finally{clearTimeout(timer);}
  };
  let until=start;
  try{
   // Observe an already-settled completion before generating the first segment.
   await Promise.resolve();check();
   while(true){
    check();if(completed)return Object.freeze({reason:'triggered',generatedUntil:until});
    const now=this.#clock.estimatedPrintTime();if(!Number.isFinite(now)||Math.abs(now)>=1e12)throw new RangeError('Invalid drip MCU time');
    if(until===end){if(now>=end){check();return Object.freeze({reason:'exhausted',generatedUntil:until});}await pause(end-now);continue;}
    const delay=until-now-.1;
    if(delay>0){await pause(delay);continue;}
    const next=Math.min(until+.05,end);if(next<=until)throw new RangeError('Unrepresentable drip segment');
    const committed=this.#coordinator.status.committedTime;
    const maintenance:unknown=this.#clock.prepareWindow?.(next);
    if(maintenance!==undefined){if(maintenance instanceof Promise)void maintenance.catch(()=>{});throw new Error('Drip maintenance must be synchronous and return no value');}
    const prepared=this.#coordinator.status;
    if(prepared.generatedTime<until||prepared.generatedTime>next||prepared.committedTime!==committed)throw new Error('Drip maintenance exceeded its generation ownership');
    until=prepared.generatedTime;check();
    // Retain all trapq history. Native compressed history is archived by sink.
    // At the trajectory endpoint flush the final direction-filter tail too.
    const flush=next===end?end:Math.max(this.#coordinator.status.committedTime,next-.002);
    await observeRetirement(this.#coordinator.advance(next,0,flush),combined);until=next;
    // Yield to serial input even when every transport promise resolves at once.
    await observeRetirement(new Promise<void>(resolve=>setImmediate(resolve)),combined);
   }
  }catch(error){
   const cleanupDeadline=new AbortController(),cleanupTimer=setTimeout(()=>cleanupDeadline.abort(new Error('Drip cleanup timed out')),5000);
   try{await observeRetirement(stop(error),cleanupDeadline.signal);}catch(cleanupError){throw new AggregateError([error,cleanupError],'Drip motion and cleanup failed');}
   finally{clearTimeout(cleanupTimer);}throw error;
  }finally{clearTimeout(timer);combined.removeEventListener('abort',cancelled);}
 }
}
