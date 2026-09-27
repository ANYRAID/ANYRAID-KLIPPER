import {observeStoppedPosition} from '../motion/stopped-position-observer.ts';
// Homing stop/readback sequence derived from klippy/mcu.py and stepper.py.
// GPL-3.0-or-later. No position authority is granted by this module.
import {SerialSession,type TimedCommandQueue} from '../protocol/serial-session.ts';
import {TriggerSyncProtocol,triggerReason} from '../inputs/trsync.ts';
import {EndstopProtocol,type EndstopSampling} from '../inputs/endstop.ts';
export interface HomingMember {
 readonly session:SerialSession;readonly queue:TimedCommandQueue;readonly trigger:TriggerSyncProtocol;
 readonly steppers:readonly {oid:number;inverted:boolean}[];
}
export interface HomingStopResult {
 readonly hitClock:bigint|null;
 readonly reasons:readonly number[];
 readonly positions:readonly {member:number;oid:number;raw:number;position:bigint;observedClock:bigint}[];
}
/** Construct before arming. The motion owner must fence generation/sends before
 * finish(), and release must synchronously detach trsync subscriptions and close
 * its native group. Readback deliberately leaves MCU SF_NEED_RESET set: resetting
 * clocks or granting homing requires a separate native/host reconciliation. */
export class HomingStopConfirmation {
 #members:readonly HomingMember[];#primary:number;#endstop:EndstopProtocol;#sampling:EndstopSampling;#release:()=>void;#timeout:number;#failure:(cause:unknown)=>void;
 #promise:Promise<HomingStopResult>|undefined;#cleanup:Promise<PromiseSettledResult<void>[]>|undefined;#cleanupPending=false;#cleanupErrors:unknown[]=[];#fault:unknown;
 constructor(members:readonly HomingMember[],primary:number,endstop:EndstopProtocol,sampling:EndstopSampling,release:()=>void,timeoutMs=5000,onFailure:(cause:unknown)=>void=()=>{}){
  if(!Array.isArray(members)||members.length<1||members.length>16||new Set(members.map(m=>m.session)).size!==members.length||!Number.isInteger(primary)||primary<0||primary>=members.length||typeof release!=='function'||typeof onFailure!=='function'||!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new RangeError('Invalid homing stop configuration');
  this.#members=members.map(m=>{
   m.session.assertCommandQueue(m.queue);m.trigger.assertDictionary(m.session.dictionary);
   if(!Array.isArray(m.steppers)||!m.steppers.length||m.steppers.length>254||new Set(m.steppers.map((s:HomingMember['steppers'][number])=>s.oid)).size!==m.steppers.length||m.steppers.some((s:HomingMember['steppers'][number])=>!Number.isInteger(s.oid)||s.oid<0||s.oid>254||s.oid===m.trigger.oid||typeof s.inverted!=='boolean'))throw new RangeError('Invalid homing steppers');
   m.session.dictionary.lookup('stepper_get_position oid=%c');m.session.dictionary.lookup('stepper_position oid=%c pos=%i');
   return {...m,steppers:m.steppers.map((s:HomingMember['steppers'][number])=>({...s}))};
  });
  if(typeof sampling.reqClock!=='bigint'||sampling.reqClock<0n||typeof sampling.restTicks!=='bigint'||sampling.restTicks<=0n||sampling.restTicks>0x7fffffffn||endstop.oid===members[primary].trigger.oid||members[primary].steppers.some((s:HomingMember['steppers'][number])=>s.oid===endstop.oid))throw new RangeError('Invalid homing endstop');
  endstop.assertDictionary(members[primary].session.dictionary);
  this.#primary=primary;this.#endstop=endstop;this.#sampling={...sampling,payload:sampling.payload.slice()};this.#release=release;this.#timeout=timeoutMs;this.#failure=onFailure;
 }
 get status(){return {started:!!this.#promise,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 /** One owner and one completion attempt. Repeated calls share the result;
  * cancellation belongs to the signal supplied by the first caller. */
 finish(signal:AbortSignal):Promise<HomingStopResult>{return this.#promise??=this.#finish(signal);}
 async #finish(signal:AbortSignal):Promise<HomingStopResult>{
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason??new Error('Homing completion cancelled'));
  signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  const timer=setTimeout(()=>controller.abort(new Error('Homing completion timed out')),this.#timeout),s=controller.signal;
  let released=false;
  try{
   s.throwIfAborted();const primary=this.#members[this.#primary];
   await primary.queue.send(this.#endstop.stop(),0n,0n,s);
   released=true;this.#release();s.throwIfAborted();
   const reasons=await Promise.all(this.#members.map(async m=>{
    const reply=await m.session.queryOnQueue(m.queue,m.trigger.trigger(triggerReason.hostRequest),'trsync_state',s,{oid:m.trigger.oid});
    const state=m.trigger.decode(reply.message);
    if(!state||state.canTrigger||state.failure)throw new Error('MCU did not confirm homing stop');return state.reason;
   }));
   const reply=await primary.session.queryOnQueue(primary.queue,this.#endstop.query(),'endstop_state',s,{oid:this.#endstop.oid});
   const state=this.#endstop.decode(reply.message);if(!state||state.homing)throw new Error('Endstop sampling did not stop');
   let hitClock:bigint|null=null;
   if(reasons[this.#primary]===triggerReason.endstopHit){
    if(reasons.some(r=>r!==triggerReason.endstopHit&&r!==triggerReason.hostRequest))throw new Error('Inconsistent coupled MCU stop reasons');
    hitClock=this.#endstop.hitClock(state,this.#sampling,c=>primary.session.clock.sync.nearestClock(c));
    if(hitClock>primary.session.clock.sync.getClock(reply.receiveTime))throw new Error('Endstop trigger is in the future');
   }
   const positions=(await Promise.all(this.#members.map(async(m,member)=>{
    const result:HomingStopResult['positions'][number][]=[];
    for(const stepper of m.steppers){
     const reply=await m.session.queryOnQueue(m.queue,m.session.dictionary.encode('stepper_get_position',{oid:stepper.oid}),'stepper_position',s,{oid:stepper.oid});
     const raw=reply.message.parameters.pos;if(typeof raw!=='number'||!Number.isInteger(raw)||raw< -0x80000000||raw>0x7fffffff)throw new Error('Invalid homing stepper position');
     const observedClock=m.session.clock.sync.getClock(reply.receiveTime);if(observedClock<0n||observedClock>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Invalid homing observation clock');
     await observeStoppedPosition(m.session,stepper.oid,BigInt(stepper.inverted?-raw:raw),s);
     result.push(Object.freeze({member,oid:stepper.oid,raw,position:BigInt(stepper.inverted?-raw:raw),observedClock}));
    }return result;
   }))).flat();
   s.throwIfAborted();for(const m of this.#members)m.session.assertActive();return Object.freeze({hitClock,reasons:Object.freeze(reasons),positions:Object.freeze(positions)});
  }catch(error){
   this.#fault=error;controller.abort(error);
   const errors:unknown[]=[error];try{this.#failure(error);}catch(notification){errors.push(notification);}if(!released)try{released=true;this.#release();}catch(cleanup){errors.push(cleanup);}
   this.#cleanupPending=true;this.#cleanup=Promise.allSettled(this.#members.map(m=>m.session.stop(error))).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);return results;}).finally(()=>{this.#cleanupPending=false;});
   let cleanupTimer:ReturnType<typeof setTimeout>|undefined;
   try{const results=await Promise.race([this.#cleanup,new Promise<never>((_,reject)=>{cleanupTimer=setTimeout(()=>reject(new Error('Homing device stop confirmation timed out')),this.#timeout);})]);for(const r of results)if(r.status==='rejected')errors.push(r.reason);}
   catch(stopError){errors.push(stopError);}finally{clearTimeout(cleanupTimer);}
   if(errors.length>1)throw new AggregateError(errors,'Homing completion and safety cleanup failed');throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
 }
}
