import type {CarriageTransformSettings} from '../motion/step-compressor.ts';
import {MotionStopConfirmation} from '../motion/stop-confirmation.ts';
import {HomingStopSetConfirmation,type HomingStopGroup,type HomingStopSetResult} from './stop-set.ts';
import {HomingStopConfirmation,type HomingMember,type HomingStopResult} from './stop-confirmation.ts';
import {rebuildStoppedMotion,type StoppedEmitter,type StoppedQueue} from './rebuild-motion.ts';
import type {MotionCoordinator,MotionBinding} from '../motion/coordinator.ts';
import type {EndstopProtocol,EndstopSampling} from '../inputs/endstop.ts';
import {observeRetirement} from '../motion/retired.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {recoveryEmitters} from './recovery-emitters.ts';
interface RecoveryOptions<T extends HomingStopResult> {
 coordinator:MotionCoordinator;bindings:readonly MotionBinding[];
 emitters:readonly StoppedEmitter[];
 /** Synchronous coordinate reconstruction after both delivery and readback.
  * Must preserve trigger/overshoot semantics and choose a future print time.
  * This callback does not grant homing authority. */
 locate:(result:T)=>{queues:readonly StoppedQueue[];printTime:number};
 timeoutMs?:number;
}
export interface HomingRecoveryOptions extends RecoveryOptions<HomingStopResult> {
 members:readonly HomingMember[];primary:number;endstop:EndstopProtocol;sampling:EndstopSampling;release:()=>void;
}
export interface HomingSetRecoveryOptions extends RecoveryOptions<HomingStopSetResult> {
 groups:readonly HomingStopGroup[];release:()=>void;
}
/** Construct before arming. Caller owns the armed trigger group and must have
 * registered every affected stepper, stopped source producers, and retained
 * trigger history. No unrelated producer may use these MCU routes meanwhile.
 * One-shot recovery does not implement arming, G28 or homed-axis authorization. */
class Recovery<T extends HomingStopResult> {
 #members:readonly HomingMember[];#stop:{finish(signal:AbortSignal):Promise<T>};#coordinator:MotionCoordinator;
 #bindings:readonly MotionBinding[];#emitters:readonly StoppedEmitter[];#locate:RecoveryOptions<T>['locate'];#timeout:number;
 #promise:Promise<{stop:T;motion:ReturnType<typeof rebuildStoppedMotion>}>|undefined;
 #carriages:ReadonlyMap<string,CarriageTransformSettings>;
 #fault:unknown;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 constructor(o:RecoveryOptions<T>,members:readonly HomingMember[],stop:{finish(signal:AbortSignal):Promise<T>},carriages:ReadonlyMap<string,CarriageTransformSettings>=new Map()){
  const timeout=o.timeoutMs??5000;
  if(!Number.isFinite(timeout)||timeout<1||timeout>60000||typeof o.locate!=='function'||!o.coordinator.usesBindings(o.bindings)||o.coordinator.status.retired||o.coordinator.status.failed||o.emitters.length!==o.bindings.length)throw new Error('Invalid homing recovery ownership');
  this.#carriages=new Map([...carriages].map(([id,transform])=>[id,{...transform}]));
  this.#members=members.map(m=>({...m,steppers:m.steppers.map(s=>({...s}))}));
  this.#stop=stop;
  const ids=new Set<string>(),keys=new Set<string>();
  for(const e of o.emitters){const m=this.#members[e.member],s=m?.steppers.find(s=>s.oid===e.settings.oid),key=`${e.member}:${e.settings.oid}`;
   if(!o.bindings.some(b=>b.id===e.id)||ids.has(e.id)||keys.has(key)||!s||s.inverted!==!!e.settings.invertDirection||e.settings.queueStepTag!==m.session.dictionary.lookup('queue_step oid=%c interval=%u count=%hu add=%hi').id||e.settings.directionTag!==m.session.dictionary.lookup('set_next_step_dir oid=%c dir=%c').id)throw new Error('Invalid homing recovery emitter');ids.add(e.id);keys.add(key);
   m.session.dictionary.lookup('reset_step_clock oid=%c clock=%u');
  }
  if(keys.size!==this.#members.reduce((sum,m)=>sum+m.steppers.length,0))throw new Error('Incomplete homing recovery steppers');
  this.#coordinator=o.coordinator;this.#bindings=o.bindings.map(b=>({...b}));this.#emitters=structuredClone(o.emitters);this.#locate=o.locate;this.#timeout=timeout;
 }
 get status(){return {started:!!this.#promise,fault:this.#fault,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 recover(signal:AbortSignal){return this.#promise??=this.#recover(signal);}
 async #recover(signal:AbortSignal){
  const abort=new AbortController(),cancel=()=>abort.abort(signal.reason??new Error('Homing recovery cancelled'));
  signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  const timer=setTimeout(()=>abort.abort(new Error('Homing recovery timed out')),this.#timeout),s=abort.signal;
  let motion:ReturnType<typeof rebuildStoppedMotion>|undefined;
  try{
   // retire fences synchronously; finish issues the stop while accepted old
   // commands drain. Never restore clocks until BOTH operations finish.
   const retirement=this.#coordinator.retire(s),confirmation=this.#stop.finish(s);
   const [,stop]=await Promise.all([observeRetirement(retirement,s),confirmation]);s.throwIfAborted();
   const located=this.#locate(stop);s.throwIfAborted();
   const emitters=recoveryEmitters(this.#bindings,this.#emitters).map(e=>{
    const carriage=this.#carriages.get(e.id);return carriage?{...e,carriage:{...carriage}}:e;
   });
   motion=rebuildStoppedMotion(stop,this.#bindings,located.queues,emitters,located.printTime);
   const resets=this.#members.map(m=>m.steppers.map(step=>m.session.dictionary.encode('reset_step_clock',{oid:step.oid,clock:0})));
   for(const m of this.#members)m.session.assertActive();
   await Promise.all(this.#members.map(async(m,i)=>{for(const payload of resets[i]){s.throwIfAborted();await m.queue.send(payload,0n,0n,s);}}));
   s.throwIfAborted();for(const m of this.#members)m.session.assertActive();
   for(const b of motion.bindings)if(b.stepper.clockAt(motion.printTime)<=this.#members[b.member].session.clock.sync.getClock(serialClock.now()))throw new Error('Recovered motion baseline has expired');
   return Object.freeze({stop,motion});
  }catch(error){
   this.#fault=error;abort.abort(error);const errors:unknown[]=[error];
   try{motion?.dispose();}catch(disposal){errors.push(disposal);}
   this.#cleanupPending=true;
   const cleanup=Promise.allSettled([this.#coordinator.shutdown(error),...this.#members.map(m=>m.session.stop(error))]).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);return results;}).finally(()=>{this.#cleanupPending=false;});
   let deadline:ReturnType<typeof setTimeout>|undefined;
   try{const results=await Promise.race([cleanup,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Homing recovery cleanup timed out')),this.#timeout);})]);for(const r of results)if(r.status==='rejected')errors.push(r.reason);}catch(cleanupError){errors.push(cleanupError);}finally{clearTimeout(deadline);}
   if(errors.length>1)throw new AggregateError(errors,'Homing recovery and cleanup failed');throw error;
  }finally{clearTimeout(timer);signal.removeEventListener('abort',cancel);}
 }
}

export class HomingRecovery extends Recovery<HomingStopResult> {
 constructor(o:HomingRecoveryOptions){super(o,o.members,new HomingStopConfirmation(o.members,o.primary,o.endstop,o.sampling,o.release,o.timeoutMs??5000));}
}
/** Independent endstops share one retirement and rebuild/reset transaction.
 * Emitter member indices refer to the group-concatenated member list. */
export class HomingSetRecovery extends Recovery<HomingStopSetResult> {
 constructor(o:HomingSetRecoveryOptions){const stop=new HomingStopSetConfirmation(o.groups,o.release,o.timeoutMs??5000);super(o,stop.members,stop);}
}

export interface CoordinateRebaseOptions extends RecoveryOptions<HomingStopResult> {
 /** Privileged affine replacement, applied only after confirmed stop and old
  * generation retirement. Caller owns draining and logical rebase geometry.
  * Every omitted emitter retains its live filters; no solver identity changes. */
 carriageTransforms?:readonly {id:string;transform:CarriageTransformSettings}[];
 members:readonly HomingMember[];
}
/** Privileged coordinate rebase after normal motion has drained. Explicitly
 * stops all listed MCU steppers, fences the old generation, reads counters and
 * rebuilds at locate's forced coordinates before resetting clocks. Does not
 * move motors to those coordinates or grant any homed-axis permission. */
export class CoordinateRebase extends Recovery<HomingStopResult> {
 constructor(o:CoordinateRebaseOptions){
  const carriages=new Map<string,CarriageTransformSettings>();
  if(o.carriageTransforms!==undefined){
   if(!Array.isArray(o.carriageTransforms)||!o.carriageTransforms.length||o.carriageTransforms.length>o.bindings.length)throw new Error('Invalid carriage rebase ownership');
   for(const item of o.carriageTransforms){
    const emitter=o.emitters.find(e=>e.id===item.id),t=item.transform;
    if(carriages.has(item.id)||!emitter||!o.bindings.some(b=>b.id===item.id)||emitter.mode==='extruder'||typeof emitter.mode==='object')throw new Error('Invalid carriage rebase emitter');
    if(!t||![t.xScale,t.xOffset,t.yScale,t.yOffset].every(Number.isFinite))throw new RangeError('Nonfinite carriage rebase transform');
    carriages.set(item.id,{xScale:t.xScale,xOffset:t.xOffset,yScale:t.yScale,yOffset:t.yOffset});
   }
  }
  const mappings=o.bindings.map(b=>{const emitter=o.emitters.find(e=>e.id===b.id);if(!emitter)throw new Error('Missing coordinate rebase emitter');return {stepper:b.stepper,member:emitter.member,offset:emitter.settings.timeOffset,frequency:emitter.settings.frequency};});
  const check=()=>{const members=new Map<number,{offset:number;frequency:number}>();for(const m of mappings){const actual=m.stepper.calibration,previous=members.get(m.member);if(actual.offset!==m.offset||actual.frequency!==m.frequency||previous&&(previous.offset!==m.offset||previous.frequency!==m.frequency))throw new Error('Coordinate rebase clock calibration differs');members.set(m.member,actual);}};
  check();const locate=o.locate;
  super({...o,locate:stop=>{check();return locate(stop);}},o.members,new MotionStopConfirmation(o.members,o.timeoutMs??5000),carriages);
 }

}
