import {HomingTriggerGroup} from './trigger-group.ts';
import {HomingTriggerSet} from './trigger-set.ts';
import {DripMotion,type DripResult} from './drip-motion.ts';
import {HomingSetRecovery,type HomingSetRecoveryOptions} from './recovery.ts';
import {homingSetRecoveryOffsets,type HomingHistoryBinding} from './position-offsets.ts';
import type {HomingStopGroup,HomingStopSetResult} from './stop-set.ts';
import {StepHistory} from '../motion/step-history.ts';
import type {StepCompressor} from '../motion/step-compressor.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {observeRetirement} from '../motion/retired.ts';
import {PrintClockTimeline} from '../timing/print-clock-timeline.ts';
export interface ArmedHomingGroup extends HomingStopGroup {readonly startClocks:readonly bigint[];readonly expireTimeout:number;}
export interface HomingReadback {
 readonly stop:HomingStopSetResult;readonly histories:readonly HomingHistoryBinding[];
 /** Missing-hit rows contain end-of-movement reference clocks, not hits. */
 readonly triggerClocks:readonly (readonly bigint[])[];
 readonly offsets:ReturnType<typeof homingSetRecoveryOffsets>['offsets'];readonly missingHits:readonly number[];
}
export interface HomingMoveOptions extends Omit<HomingSetRecoveryOptions,'groups'|'release'|'locate'|'timeoutMs'> {
 readonly groups:readonly ArmedHomingGroup[];readonly histories:readonly HomingHistoryBinding[];
 readonly startTime:number;readonly endTime:number;readonly timeoutMs?:number;
 /** Complete emitter coverage, sharing one timeline for each physical MCU. */
 readonly clockTimelines?:ReadonlyMap<string,PrintClockTimeline>;
 readonly prepareWindow?:(until:number)=>void;
 /** Schedule device output only after drip stops, before readback. Must not
  * sample the homing endstop, move axes or grant position authority. */
 readonly onTriggered?:(signal:AbortSignal)=>Promise<void>;
 readonly locate:(readback:HomingReadback)=>ReturnType<HomingSetRecoveryOptions['locate']>;
}
/** One actual native homing pass: arm -> drip -> stop/readback -> retire/reset.
 * The source owner must preload the admitted trajectory (and filter padding),
 * generate the start baseline, archive every sink output into the supplied
 * histories, and exclude all other producers during this pass. Shared-clock
 * calibration is permitted only through synchronous prepareWindow ownership.
 * The returned replacement remains caller-owned; adopt it before further work.
 * No-hit results remain no-hit after recovery and never grant homed authority. */
export class HomingMoveExecution {
 #set:HomingTriggerSet;#recovery:HomingSetRecovery;#drip:DripMotion;#o:HomingMoveOptions;
 #members:HomingStopGroup['members'];#representatives:StepCompressor[];#mappings:{stepper:StepCompressor;offset:number;frequency:number;timeline?:PrintClockTimeline}[];
 #timelines:(PrintClockTimeline|undefined)[]=[];
 #readback:HomingReadback|undefined;#promise:Promise<HomingReadback&{motion:Awaited<ReturnType<HomingSetRecovery['recover']>>['motion'];drip:DripResult}>|undefined;
 #finished=false;#disposed=false;#cleanupPending=false;#cleanupErrors:unknown[]=[];
 constructor(options:HomingMoveOptions){
  const timeout=options.timeoutMs??60000;
  if(!Number.isInteger(timeout)||timeout<1||timeout>3600000||!Number.isFinite(options.startTime)||options.startTime<0||!Number.isFinite(options.endTime)||options.endTime<options.startTime||options.endTime>=1e12||options.coordinator.status.generatedTime!==options.startTime||options.coordinator.status.busy||options.coordinator.status.failed||options.coordinator.status.retired||!options.coordinator.usesBindings(options.bindings)||typeof options.locate!=='function'||options.onTriggered!==undefined&&typeof options.onTriggered!=='function')throw new Error('Invalid homing move boundary');
  this.#o={...options,clockTimelines:options.clockTimelines?new Map(options.clockTimelines):undefined,timeoutMs:timeout,groups:options.groups.map(g=>({...g,startClocks:[...g.startClocks],members:g.members.map(m=>({...m,steppers:m.steppers.map(s=>({...s}))})),sampling:{...g.sampling,payload:g.sampling.payload.slice()}})),bindings:options.bindings.map(b=>({...b})),emitters:structuredClone(options.emitters),histories:Object.freeze(options.histories.map(h=>Object.freeze({...h})))};
  const o=this.#o;this.#members=o.groups.flatMap(g=>g.members);this.#mappings=[];this.#representatives=[];
  if(o.clockTimelines&&(o.clockTimelines.size!==o.bindings.length||o.bindings.some(b=>!(o.clockTimelines!.get(b.id) instanceof PrintClockTimeline)))||o.prepareWindow&&(!o.clockTimelines||typeof o.prepareWindow!=='function'))throw new Error('Invalid homing shared clock coverage');
  const sessionTimelines=new Map<HomingStopGroup['members'][number]['session'],PrintClockTimeline>();
  if(o.histories.length!==o.bindings.length||new Set(o.histories.map(h=>`${h.member}:${h.oid}`)).size!==o.histories.length)throw new Error('Invalid homing history coverage');
  const starts=o.groups.flatMap(g=>g.startClocks),sessionMappings=new Map<HomingStopGroup['members'][number]['session'],{offset:number;frequency:number}>();
  for(const [member,m] of this.#members.entries()){
   for(const s of m.steppers){
    const emitter=o.emitters.find(e=>e.member===member&&e.settings.oid===s.oid),binding=o.bindings.find(b=>b.id===emitter?.id),history=o.histories.find(h=>h.member===member&&h.oid===s.oid);
    if(!emitter||!binding||!(history?.history instanceof StepHistory))throw new Error('Missing homing emitter or history');
    const calibration=binding.stepper.calibration,clock=binding.stepper.clockAt(o.startTime),representative=this.#representatives[member];
    const timeline=o.clockTimelines?.get(binding.id);
    if(timeline){const shared=timeline.status.calibration,previous=sessionTimelines.get(m.session);if(shared.offset!==calibration.offset||shared.frequency!==calibration.frequency||timeline.clockAt(o.startTime)!==clock||previous&&previous!==timeline||[...sessionTimelines].some(([session,t])=>session!==m.session&&t===timeline))throw new Error('Homing shared clock mapping differs');sessionTimelines.set(m.session,timeline);this.#timelines[member]=timeline;}
    if(clock!==starts[member]||history.history.status.throughClock!==clock||emitter.settings.timeOffset!==calibration.offset||emitter.settings.frequency!==calibration.frequency||representative&&(representative.calibration.offset!==calibration.offset||representative.calibration.frequency!==calibration.frequency))throw new Error('Homing clock mapping or history baseline differs');
    const previous=sessionMappings.get(m.session);if(previous&&(previous.offset!==calibration.offset||previous.frequency!==calibration.frequency))throw new Error('Shared MCU homing calibration differs');sessionMappings.set(m.session,calibration);
    this.#representatives[member]=binding.stepper;this.#mappings.push({stepper:binding.stepper,...calibration,timeline});
   }
  }
  const groups:HomingTriggerGroup[]=[];let set:HomingTriggerSet|undefined;
  try{
   for(const g of o.groups)groups.push(new HomingTriggerGroup(g.members,g.primary,g.endstop,g.sampling,g.startClocks,g.expireTimeout));
   this.#set=set=new HomingTriggerSet(groups);
   this.#recovery=new HomingSetRecovery({...o,timeoutMs:5000,release:()=>this.#set.release(),locate:stop=>{
    this.#checkMappings();let offset=0;
    const clocks=o.groups.map((g,i)=>{
     const hit=stop.groups[i].hitClock,primary=offset+g.primary,printTime=hit===null?o.endTime:this.#clock(primary).printTimeAtClock(hit);
     const row=g.members.map((_,m)=>hit!==null&&m===g.primary?hit:this.#clock(offset+m).clockAt(printTime));offset+=g.members.length;return Object.freeze(row);
    });
    const recovered=homingSetRecoveryOffsets(stop,o.histories,clocks);
    const readback=Object.freeze({stop,histories:o.histories,triggerClocks:Object.freeze(clocks),...recovered});
    const located=o.locate(readback);this.#readback=readback;return located;
   }});
   this.#drip=new DripMotion(o.coordinator,this.#set,{prepareWindow:o.prepareWindow?until=>{this.#checkMappings();const result=o.prepareWindow!(until);this.#checkMappings();return result;}:undefined,estimatedPrintTime:()=>{
    this.#checkMappings();const now=serialClock.now();let time=Infinity;
    for(const [i,m] of this.#members.entries()){m.session.assertActive();m.session.clock.assertActive();time=Math.min(time,this.#clock(i).printTimeAtClock(m.session.clock.sync.getClock(now)));}return time;
   }});
  }catch(error){if(set)set.release();else for(const group of groups)group.release();throw error;}
 }
 #clock(member:number){return this.#timelines[member]??this.#representatives[member];}
 #checkMappings(){for(const {stepper,offset,frequency,timeline} of this.#mappings){const current=stepper.calibration,saved=timeline?.status.calibration??{offset,frequency};if(current.offset!==saved.offset||current.frequency!==saved.frequency)throw new Error('Homing clock calibration changed');}}
 get status(){return {started:!!this.#promise,finished:this.#finished,disposed:this.#disposed,cleanupPending:this.#cleanupPending,cleanupErrors:[...this.#cleanupErrors]};}
 run(signal:AbortSignal){if(this.#disposed)return Promise.reject(new Error('Homing move disposed'));return this.#promise??=this.#run(signal);}
 async #run(signal:AbortSignal){
  const local=new AbortController(),s=AbortSignal.any([signal,local.signal]),sessions=[...new Set(this.#members.map(m=>m.session))];let cleanup:Promise<void>|undefined,motion:Awaited<ReturnType<HomingSetRecovery['recover']>>['motion']|undefined;
  const stop=(error:unknown)=>{if(cleanup)return cleanup;this.#cleanupPending=true;cleanup=Promise.allSettled([this.#set.stop(error),this.#o.coordinator.shutdown(error),...sessions.map(session=>session.stop(error))]).then(results=>{this.#cleanupErrors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(this.#cleanupErrors.length)throw new AggregateError(this.#cleanupErrors,'Homing move safety failures');}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});return cleanup;};
  const abort=()=>{void stop(s.reason);};s.addEventListener('abort',abort,{once:true});const timer=setTimeout(()=>local.abort(new Error('Homing move timed out')),this.#o.timeoutMs!);
  const releaseHistory:(()=>void)[]=[];
  const run=async<T>(work:Promise<T>):Promise<T>=>{let result!:T;await observeRetirement(work.then(value=>{result=value;}),s);s.throwIfAborted();return result;};
  try{
   s.throwIfAborted();for(const h of this.#o.histories)releaseHistory.push(h.history.pin());for(const timeline of new Set(this.#timelines.filter(t=>t!==undefined))){const lease=timeline.retain(timeline.clockAt(this.#o.startTime));releaseHistory.push(()=>lease.release());}this.#checkMappings();await run(this.#set.arm(s));
   const drip=await run(this.#drip.run(this.#o.startTime,this.#o.endTime,s,this.#o.timeoutMs));
   if(drip.reason==='triggered'&&this.#o.onTriggered)await run(this.#o.onTriggered(s));
   this.#checkMappings();await run(this.#recovery.recover(s).then(result=>{if(s.aborted){result.motion.dispose();throw s.reason;}motion=result.motion;return result;}));
   for(const session of sessions)session.assertActive();s.throwIfAborted();if(!this.#readback)throw new Error('Missing homing readback');
   if(!motion)throw new Error('Missing recovered motion');return Object.freeze({...this.#readback,motion,drip});
  }catch(error){
   local.abort(error);const errors:unknown[]=[error];try{motion?.dispose();}catch(disposal){errors.push(disposal);}const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Homing move cleanup timed out')),5000);
   try{await observeRetirement(stop(error),deadline.signal);}catch(cleanupError){errors.push(cleanupError);}finally{clearTimeout(timer);}if(errors.length>1)throw new AggregateError(errors,'Homing move and cleanup failed');throw error;
  }finally{for(const release of releaseHistory)release();this.#finished=true;clearTimeout(timer);s.removeEventListener('abort',abort);}
 }
 /** Release unused native dispatch resources; an active pass must be cancelled
  * via its run signal so that physical safety cleanup cannot be skipped. */
 dispose(){if(this.#promise&&!this.#finished)throw new Error('Cancel active homing before disposal');if(!this.#disposed){this.#disposed=true;this.#set.release();}}
 [Symbol.dispose](){this.dispose();}
}
