import {observeStoppedPosition} from '../motion/stopped-position-observer.ts';
// Explicit stepper stop using the existing MCU trsync/stepper_stop protocol.
import type {HomingMember,HomingStopResult} from '../homing/stop-confirmation.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {triggerReason} from '../inputs/trsync.ts';
import {observeRetirement} from './retired.ts';
/** Coordinate rebasing requires a dedicated or physically stopped trsync OID
 * with all associated endstop sampling disabled, plus exclusive ownership of
 * every listed stepper on each MCU. Drain ordinary
 * movement before entering this boundary; stopping queued remnants does not
 * establish that the requested path completed. No endstop hit is inferred. */
export class MotionStopConfirmation {
 #members:readonly HomingMember[];#timeout:number;#promise:Promise<HomingStopResult>|undefined;
 #fault:unknown;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 constructor(members:readonly HomingMember[],timeoutMs=5000){
  if(!Array.isArray(members)||!members.length||members.length>16||new Set(members.map(m=>m.session)).size!==members.length||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new RangeError('Invalid motion stop members');
  let count=0;
  this.#members=members.map((m:HomingMember)=>{
   m.session.assertCommandQueue(m.queue);m.trigger.assertDictionary(m.session.dictionary);
   if(!m.steppers.length||new Set(m.steppers.map(s=>s.oid)).size!==m.steppers.length||m.steppers.some(s=>!Number.isInteger(s.oid)||s.oid<0||s.oid>254||s.oid===m.trigger.oid||typeof s.inverted!=='boolean'))throw new RangeError('Invalid motion stop steppers');
   m.session.dictionary.lookup('stepper_get_position oid=%c');m.session.dictionary.lookup('stepper_position oid=%c pos=%i');count+=m.steppers.length;
   return {...m,steppers:m.steppers.map(s=>({...s}))};
  });
  if(count>128)throw new RangeError('Motion stop stepper capacity exceeded');this.#timeout=timeoutMs;
 }
 get status(){return {started:!!this.#promise,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 finish(signal:AbortSignal):Promise<HomingStopResult>{return this.#promise??=this.#finish(signal);}
 async #finish(signal:AbortSignal):Promise<HomingStopResult>{
  const local=new AbortController(),s=AbortSignal.any([signal,local.signal]),remove:(()=>void)[]=[];
  let cleanup:Promise<void>|undefined;
  const stop=(cause:unknown)=>{if(cleanup)return cleanup;this.#cleanupPending=true;cleanup=Promise.allSettled(this.#members.map(m=>m.session.stop(cause))).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(this.#cleanupErrors.length)throw new AggregateError(this.#cleanupErrors,'Motion stop safety failures');}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;};
  const abort=()=>{void stop(s.reason);};s.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>local.abort(new Error('Motion stop timed out')),this.#timeout);
  try{
   s.throwIfAborted();for(const m of this.#members)remove.push(m.session.observeClose(cause=>local.abort(cause)));
   const work=Promise.all(this.#members.map(async(m,member)=>{
    try{
     // This query checks response-route ownership before changing registrations,
     // and terminates any old callbacks on this released trigger object.
     const previous=await m.session.queryOnQueue(m.queue,m.trigger.trigger(triggerReason.hostRequest),'trsync_state',s,{oid:m.trigger.oid});
     const state=m.trigger.decode(previous.message);if(!state||state.canTrigger||state.reason>=triggerReason.commsTimeout)throw new Error('Previous motion trigger is faulted');
     const now=serialClock.now(),clock=m.session.clock.sync.getClock(now),expire=m.session.clock.sync.getClock(now+1);
     if(clock<0n||expire-clock<=0n||expire-clock>0x7fffffffn)throw new RangeError('Invalid motion stop watchdog horizon');
     const dictionary=m.session.dictionary;
     // Suppress periodic reports so an unrelated active report cannot satisfy
     // the stop query. The MCU watchdog remains armed during registration.
     await m.queue.send(dictionary.encode('trsync_start',{oid:m.trigger.oid,report_clock:0,report_ticks:0,expire_reason:triggerReason.commsTimeout}),0n,0n,s);
     await m.queue.send(dictionary.encode('trsync_set_timeout',{oid:m.trigger.oid,clock:Number(BigInt.asUintN(32,expire))}),0n,0n,s);
     for(const stepper of m.steppers)await m.queue.send(dictionary.encode('stepper_stop_on_trigger',{oid:stepper.oid,trsync_oid:m.trigger.oid}),0n,0n,s);
     if(m.session.clock.sync.getClock(serialClock.now())>=expire)throw new Error('Motion stop registration deadline expired');
     const stopped=await m.session.queryOnQueue(m.queue,m.trigger.trigger(triggerReason.hostRequest),'trsync_state',s,{oid:m.trigger.oid});
     const final=m.trigger.decode(stopped.message);if(!final||final.canTrigger||final.reason!==triggerReason.hostRequest)throw new Error('MCU did not confirm requested motion stop');
     const positions:HomingStopResult['positions'][number][]=[];
     for(const stepper of m.steppers){
      const reply=await m.session.queryOnQueue(m.queue,dictionary.encode('stepper_get_position',{oid:stepper.oid}),'stepper_position',s,{oid:stepper.oid});
      const raw=reply.message.parameters.pos,observedClock=m.session.clock.sync.getClock(reply.receiveTime);
      if(typeof raw!=='number'||!Number.isInteger(raw)||raw< -0x80000000||raw>0x7fffffff||observedClock<0n||observedClock>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid stopped position readback');
      await observeStoppedPosition(m.session,stepper.oid,BigInt(stepper.inverted?-raw:raw),s);
      positions.push(Object.freeze({member,oid:stepper.oid,raw,position:BigInt(stepper.inverted?-raw:raw),observedClock}));
     }
     return positions;
    }catch(error){local.abort(error);throw error;}
   }));
   let positions:HomingStopResult['positions']=[];await observeRetirement(work.then(rows=>{positions=Object.freeze(rows.flat());}),s);
   s.throwIfAborted();for(const m of this.#members)m.session.assertActive();return Object.freeze({hitClock:null,reasons:Object.freeze(this.#members.map(()=>triggerReason.hostRequest)),positions});
  }catch(error){
   this.#fault=error;local.abort(error);const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Motion stop cleanup timed out')),this.#timeout);
   try{await observeRetirement(stop(error),deadline.signal);}catch(cleanupError){throw new AggregateError([error,cleanupError],'Motion stop and safety cleanup failed');}finally{clearTimeout(timer);}throw error;
  }finally{remove.forEach(fn=>fn());clearTimeout(timer);s.removeEventListener('abort',abort);}
 }
}
