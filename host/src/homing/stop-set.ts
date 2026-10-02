import {HomingStopConfirmation,type HomingMember,type HomingStopResult} from './stop-confirmation.ts';
import type {EndstopProtocol,EndstopSampling} from '../inputs/endstop.ts';
import {observeRetirement} from '../motion/retired.ts';
export interface HomingStopGroup {readonly members:readonly HomingMember[];readonly primary:number;readonly endstop:EndstopProtocol;readonly sampling:EndstopSampling;}
export interface HomingStopSetResult extends HomingStopResult {
 /** There is deliberately no single authoritative trigger clock for the set. */
 readonly hitClock:null;
 readonly groups:readonly HomingStopResult[];
 readonly memberOffsets:readonly number[];
}
/** Construct before arming, fence producers before finish. Global release must
 * detach the entire trigger set synchronously. Member indices in the flattened
 * result identify group routes, NOT distinct physical MCUs; shared sessions
 * retain independent trigger reasons and clock mappings. */
export class HomingStopSetConfirmation {
 readonly members:readonly HomingMember[];
 #groups:readonly HomingStopGroup[];#stops:HomingStopConfirmation[];#release:()=>void;#timeout:number;
 #abort:AbortController|undefined;#promise:Promise<HomingStopSetResult>|undefined;#fault:unknown;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 constructor(groups:readonly HomingStopGroup[],release:()=>void,timeoutMs=5000){
  if(!Array.isArray(groups)||!groups.length||groups.length>16||typeof release!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)throw new RangeError('Invalid independent homing groups');
  this.#groups=groups.map((g:HomingStopGroup)=>({...g,members:g.members.map(m=>Object.freeze({...m,steppers:Object.freeze(m.steppers.map(s=>Object.freeze({...s})))})),sampling:{...g.sampling,payload:g.sampling.payload.slice()}}));
  this.#stops=this.#groups.map((g:HomingStopGroup)=>new HomingStopConfirmation(g.members,g.primary,g.endstop,g.sampling,()=>{},timeoutMs,error=>this.#abort?.abort(error)));
  const owned=new Map<HomingMember['session'],Set<number>>();
  for(const g of this.#groups)for(const [i,m] of g.members.entries()){
   const ids=owned.get(m.session)??new Set<number>();owned.set(m.session,ids);
   for(const oid of [m.trigger.oid,...m.steppers.map(s=>s.oid),...(i===g.primary?[g.endstop.oid]:[])]){if(ids.has(oid))throw new Error('Independent homing OID ownership overlaps');ids.add(oid);}
  }
  this.members=Object.freeze(this.#groups.flatMap(g=>g.members));
  if(this.members.length>128||this.members.reduce((n,m)=>n+m.steppers.length,0)>128)throw new RangeError('Too many independent homing members');
  this.#release=release;this.#timeout=timeoutMs;
 }
 get status(){return {started:!!this.#promise,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 finish(signal:AbortSignal):Promise<HomingStopSetResult>{return this.#promise??=this.#finish(signal);}
 async #finish(signal:AbortSignal):Promise<HomingStopSetResult>{
  const local=this.#abort=new AbortController(),s=AbortSignal.any([signal,local.signal]),sessions=[...new Set(this.members.map(m=>m.session))];
  let cleanup:Promise<void>|undefined,released=false;const unsubscribe:(()=>void)[]=[];
  const release=()=>{if(!released){released=true;this.#release();}};
  const stop=(cause:unknown)=>{if(cleanup)return cleanup;this.#cleanupPending=true;
   cleanup=Promise.allSettled(sessions.map(m=>m.stop(cause))).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(this.#cleanupErrors.length)throw new AggregateError(this.#cleanupErrors,'Independent homing safety failures');}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;
  };
  const abort=()=>{void stop(s.reason);};s.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>local.abort(new Error('Independent homing confirmation timed out')),this.#timeout);
  try{
   s.throwIfAborted();for(const session of sessions)unsubscribe.push(session.observeClose(cause=>local.abort(cause)));
   await observeRetirement(Promise.all(this.#groups.map((g:HomingStopGroup)=>g.members[g.primary].queue.send(g.endstop.stop(),0n,0n,s))),s);
   s.throwIfAborted();release();
   // Single-group confirmation repeats the idempotent disable command. Keeping
   // its established ACK/freshness checks avoids a public "already safe" bypass.
   const work=Promise.all(this.#stops.map(stop=>stop.finish(s)));
   const results:HomingStopResult[]=[];await observeRetirement(work.then(groups=>{results.push(...groups);}),s);const groups=results;s.throwIfAborted();
   for(const session of sessions)session.assertActive();
   const memberOffsets:number[]=[],reasons:number[]=[],positions:HomingStopResult['positions'][number][]=[];
   for(const group of groups){const offset=reasons.length;memberOffsets.push(offset);reasons.push(...group.reasons);positions.push(...group.positions.map(p=>Object.freeze({...p,member:offset+p.member})));}
   return Object.freeze({hitClock:null,groups:Object.freeze(groups),memberOffsets:Object.freeze(memberOffsets),reasons:Object.freeze(reasons),positions:Object.freeze(positions)});
  }catch(error){
   this.#fault=error;local.abort(error);const errors:unknown[]=[error];try{release();}catch(e){errors.push(e);}
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Independent homing cleanup timed out')),this.#timeout);
   try{await observeRetirement(stop(error),deadline.signal);}catch(e){errors.push(e);}finally{clearTimeout(timer);}
   if(errors.length>1)throw new AggregateError(errors,'Independent homing and cleanup failed');throw error;
  }finally{for(const remove of unsubscribe)remove();clearTimeout(timer);s.removeEventListener('abort',abort);}
 }
}
