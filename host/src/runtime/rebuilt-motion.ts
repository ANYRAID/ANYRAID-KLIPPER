import {plannedQueuePosition} from '../motion/planned-queue.ts';
import {PrintClockTimeline,readPrintClock} from '../timing/print-clock-timeline.ts';
import {SecondarySync} from '../timing/secondary-sync.ts';
import {CalibrationCadence} from '../timing/calibration-cadence.ts';
import {MCUGroup} from './mcu-group.ts';
import type {HomingMember} from '../homing/stop-confirmation.ts';
import type {rebuildStoppedMotion} from '../homing/rebuild-motion.ts';
import {MotionCoordinator} from '../motion/coordinator.ts';
import {MoveQueueSink} from '../motion/move-queue-sink.ts';
import {CoordinatedMotionDrain,type AuxiliaryMCUClock} from '../motion/coordinated-drain.ts';
import {PlannedMotionSource,type PlannedQueue,type SourceBoundaryOutput} from '../motion/planned-motion-source.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {waitForMcuClocks} from '../timing/mcu-clock-barrier.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
import type {MotorEnable} from '../outputs/motor-enable.ts';
type ClockedBoundaryOutput=Omit<SourceBoundaryOutput,'settle'>&{readonly names?:readonly string[];readonly status:{pending:number;busy:boolean;stopped:boolean};register(value:number,name?:string):number;settleScheduled(signal:AbortSignal):Promise<number>;retireThrough(time:number):void;subscribeStop(listener:(cause:unknown)=>void):()=>void};
const outputOwners=new WeakSet<ClockedBoundaryOutput>();
const clockCadences=new WeakMap<SecondarySync,CalibrationCadence>();
interface OutputClock {timeline?:PrintClockTimeline;session:HomingMember['session'];clock:ReturnType<typeof snapshotPrintClock>;}
interface OutputContext extends OutputClock {peers:readonly OutputClock[];target:ClockedBoundaryOutput;group:MCUGroup;owner:symbol|undefined;}
/** Opaque, one-use handoff. Only releaseBoundaryOutput can create a valid token. */
export interface BoundaryOutputTransfer {readonly kind:'boundary-output-transfer';}
const transfers=new WeakMap<BoundaryOutputTransfer,{context:OutputContext;coordinator:MotionCoordinator}>();
export interface RebuiltMotionOptions {
 group:MCUGroup;
 clockTimelines?:readonly {id:string;timeline:PrintClockTimeline;synchronizer?:SecondarySync}[];
 /** Exact physical members used by the successful stop/recovery transaction. */
 members:readonly HomingMember[];
 /** Explicit non-motion controllers. They remain in group safety and clocks. */
 auxiliaryMCUs?:readonly AuxiliaryMCUClock[];
 motion:ReturnType<typeof rebuildStoppedMotion>;
 routes:readonly PlannedQueue[];
 position:readonly number[];
 /** Dedicated output with the same print-time calibration as this MCU member. */
 boundaryOutput?:{output:ClockedBoundaryOutput;member:number}|{output:ClockedBoundaryOutput;mcu:string}|{output:ClockedBoundaryOutput;mcus:readonly string[]};
 boundaryTransfer?:BoundaryOutputTransfer;
 motorEnable?:MotorEnable;
}
/** Adopt the output of a completed recovery (including reset ACKs) into real
 * group transports, history retention, generation and MCU-time drain. Caller
 * transfers exclusive ownership: failure stops the group and disposes motion.
 * Does not perform stop/reset itself, authorize homing or admit G-code. */
export async function bindRebuiltMotion(o:RebuiltMotionOptions){
 const {group,motion}=o;
 let ownedOutput:ClockedBoundaryOutput|undefined;
 let ownedCoordinator:MotionCoordinator|undefined;
 try{
  group.assertActive();
  const ids=group.status.devices.map(d=>d.id),members=o.members.map(m=>Object.freeze({...m,steppers:Object.freeze(m.steppers.map(s=>Object.freeze({...s})))}));
  const clockTimelines=o.clockTimelines===undefined?undefined:Object.freeze(o.clockTimelines.map(c=>Object.freeze({...c})));
  if(clockTimelines&&(clockTimelines.length!==ids.length||new Set(clockTimelines.map(c=>c.id)).size!==ids.length||new Set(clockTimelines.map(c=>c.timeline)).size!==ids.length||clockTimelines.some(c=>!ids.includes(c.id)||!(c.timeline instanceof PrintClockTimeline))))throw new Error('Shared clocks must cover each MCU with a distinct timeline');
  const timelineFor=(id:string)=>clockTimelines?.find(c=>c.id===id)?.timeline;
  for(const c of clockTimelines??[]){const sync=c.synchronizer;if(!sync)continue;const mapping=c.timeline.status.calibration,current=sync.mapping;if(!(sync instanceof SecondarySync)||current.offset!==mapping.offset||current.frequency!==mapping.frequency||!ids.some(id=>id!==c.id&&sync.usesClocks(group.session(id).clock.sync,group.session(c.id).clock.sync)))throw new Error('Shared synchronizer differs from MCU timeline');}
  const auxiliaryMCUs=Object.freeze((o.auxiliaryMCUs??[]).map(a=>{const timeline=timelineFor(a.id)??a.timeline,c=snapshotPrintClock(timeline?.status.calibration??a.calibration),saved=Object.freeze({offset:c.offset,frequency:c.frequency});return Object.freeze({id:a.id,timeline,get calibration(){return timeline?.status.calibration??saved;}});}));
  if(ids.length!==members.length+auxiliaryMCUs.length||new Set(members.map(m=>m.session)).size!==members.length)throw new Error('Rebuilt motion requires every physical MCU');
  const routes=members.map(m=>{const id=ids.find(id=>group.session(id)===m.session);if(!id)throw new Error('Rebuilt member does not belong to MCU group');m.session.assertCommandQueue(m.queue);return id;});
  const covered=[...routes,...auxiliaryMCUs.map(a=>a.id)];if(new Set(covered).size!==covered.length||covered.some(id=>!ids.includes(id)))throw new Error('Invalid auxiliary MCU coverage');for(const a of auxiliaryMCUs)group.session(a.id).configuration;
  const bindings=motion.bindings;
  if(!bindings.length||bindings.some(b=>!Number.isInteger(b.member)||!members[b.member]||b.stepper.generatedTime!==motion.printTime))throw new Error('Invalid rebuilt motion baseline');
  const grouped=members.map((m,i)=>{
   const owned=bindings.filter(b=>b.member===i);
   if(!owned.length||owned.length!==m.steppers.length||new Set(owned.map(b=>b.oid)).size!==owned.length||owned.some(b=>!m.steppers.some(s=>s.oid===b.oid&&s.inverted===b.inverted)))throw new Error('Incomplete rebuilt MCU bindings');
   const calibration=owned[0].stepper.calibration,shared=timelineFor(routes[i])?.status.calibration;if(shared&&(calibration.offset!==shared.offset||calibration.frequency!==shared.frequency))throw new Error('Motion differs from shared MCU calibration');
   if(owned.some(b=>b.stepper.calibration.offset!==calibration.offset||b.stepper.calibration.frequency!==calibration.frequency))throw new Error('Rebuilt MCU clocks differ');
   return owned;
  });
  const clockMembers=Object.freeze([...members.map((m,i)=>Object.freeze({mcu:routes[i],timeline:timelineFor(routes[i]),session:m.session,stepper:timelineFor(routes[i])?readPrintClock(grouped[i][0].stepper.calibration,timelineFor(routes[i])):grouped[i][0].stepper,calibration:()=>grouped[i][0].stepper.calibration})),...auxiliaryMCUs.map(a=>Object.freeze({mcu:a.id,timeline:a.timeline,session:group.session(a.id),stepper:readPrintClock(a.calibration,a.timeline),calibration:()=>a.calibration}))]);
  if(o.routes.length!==motion.queues.length||new Set(o.routes.map(r=>r.queue)).size!==o.routes.length)throw new Error('Rebuilt source queue coverage differs');
  for(const r of o.routes){const q=motion.queues.find(q=>q.queue===r.queue),p=plannedQueuePosition(r,o.position);if(!q||q.position.some((v,i)=>v!==p[i]))throw new Error('Rebuilt source coordinate differs from recovery');}
  const calibrations=bindings.map(b=>b.stepper.calibration);
  const assertClockCalibration=()=>{group.assertActive();for(const [i,b] of bindings.entries()){const current=b.stepper.calibration,saved=timelineFor(routes[b.member])?.status.calibration??calibrations[i];if(current.offset!==saved.offset||current.frequency!==saved.frequency)throw new Error('Motion clock calibration changed outside shared timeline');}};
  const assertMotorCalibration=()=>{if(!o.motorEnable)return;assertClockCalibration();o.motorEnable.assertBindings(group,bindings.map(b=>({id:b.id,mcu:routes[b.member],calibration:b.stepper.calibration})),bindings[0].stepper.generatedTime);};
  const check=()=>{group.assertActive();for(const [i,b] of bindings.entries()){const current=b.stepper.calibration,saved=calibrations[i];if(current.offset!==saved.offset||current.frequency!==saved.frequency)throw new Error('Rebuilt motion calibration changed before start');}const now=serialClock.now();for(const m of clockMembers)if(m.stepper.clockAt(motion.printTime)<=m.session.clock.sync.getClock(now))throw new Error('Rebuilt motion baseline expired before binding');};
  check();
  o.motorEnable?.assertBindings(group,bindings.map(b=>({id:b.id,mcu:routes[b.member],calibration:b.stepper.calibration})),motion.printTime);
  let output:SourceBoundaryOutput|undefined,context:OutputContext|undefined,capability:ClockedBoundaryOutput|undefined;const owner=Symbol('boundary output owner');let checkMapping=()=>{};
  if(o.boundaryOutput&&o.boundaryTransfer)throw new Error('Choose initial output or output transfer');
  if(o.boundaryOutput||o.boundaryTransfer){
   let member:number;
   if(o.boundaryTransfer){
    const transfer=transfers.get(o.boundaryTransfer);if(!transfer)throw new Error('Invalid or consumed boundary output transfer');
    context=transfer.context;ownedOutput=context.target;member=clockMembers.findIndex(m=>m.session===context!.session);
    if(context.timeline!==clockMembers[member]?.timeline||context.group!==group||context.owner!==undefined||member<0||!transfer.coordinator.retirementComplete)throw new Error('Boundary output transfer requires retired motion on the same MCU group');
    const next=clockMembers[member].calibration();if(next.offset!==context.clock.offset||next.frequency!==context.clock.frequency)throw new Error('Boundary output transfer clock mapping differs');
    for(const peer of context.peers){const binding=clockMembers.find(m=>m.session===peer.session),next=binding?.calibration();if(!next||binding!.timeline!==peer.timeline||next.offset!==peer.clock.offset||next.frequency!==peer.clock.frequency)throw new Error('Boundary output transfer clock mapping differs');}
    transfers.delete(o.boundaryTransfer);
   }else{
    const selector=o.boundaryOutput!,target=selector.output;
    const selected='mcus' in selector?selector.mcus:undefined;
    if(selected&&(!selected.length||new Set(selected).size!==selected.length||selected.some(id=>!clockMembers.some(m=>m.mcu===id))))throw new Error('Invalid boundary output MCU coverage');
    member='member' in selector?selector.member:clockMembers.findIndex(m=>m.mcu===('mcu' in selector?selector.mcu:selected![0]));
    if('member' in selector&&!members[member])throw new Error('Invalid boundary output MCU or ownership');
    if(!Number.isInteger(member)||!clockMembers[member]||outputOwners.has(target)||target.status.stopped||target.status.busy)throw new Error('Invalid boundary output MCU or ownership');
    const peers=Object.freeze((selected?selected.map(id=>clockMembers.find(m=>m.mcu===id)!):[clockMembers[member]]).map(m=>Object.freeze({session:m.session,clock:readPrintClock(m.calibration(),m.timeline),timeline:m.timeline})));
    outputOwners.add(target);ownedOutput=target;context={target,group,...peers[0],peers,owner:undefined};
    let offGroup=()=>{},offOutput=()=>{};
    offGroup=group.subscribeStop(cause=>{void target.stop(cause).catch(()=>{});offGroup();offOutput();});
    offOutput=target.subscribeStop(cause=>{void group.stop(cause).catch(()=>{});});
   }
   const ctx=context,target=ctx.target,binding=clockMembers[member],mapping=ctx.clock;
   if(target.status.stopped||target.status.busy||o.boundaryTransfer&&target.status.pending)throw new Error('Boundary output is not available');ctx.owner=owner;
   const assertOwner=()=>{group.assertActive();if(ctx.owner!==owner)throw new Error('Boundary output ownership transferred');};
   checkMapping=()=>{
    assertOwner();const current=binding.calibration();
    if(current.offset!==mapping.offset||current.frequency!==mapping.frequency)throw new Error('Boundary output clock calibration changed');
    for(const peer of ctx.peers){const current=clockMembers.find(m=>m.session===peer.session)!.calibration();if(current.offset!==peer.clock.offset||current.frequency!==peer.clock.frequency)throw new Error('Boundary output clock calibration changed');}
   };
   output={deliver:async(boundaries,horizon,signal)=>{
    checkMapping();
    target.retireThrough(Math.min(...ctx.peers.map(p=>p.clock.printTimeAtClock(p.session.clock.sync.lastClock))));
    await target.deliver(boundaries,horizon,signal);group.assertActive();
   },settle:async signal=>{
    checkMapping();const horizon=await target.settleScheduled(signal);signal.throwIfAborted();checkMapping();
    if(!Number.isFinite(horizon)||horizon<0)throw new Error('Invalid boundary output settlement horizon');
    await waitForMcuClocks(ctx.peers.map(p=>({clock:p.session.clock,tick:p.clock.clockAt(horizon)})),signal);
    signal.throwIfAborted();checkMapping();target.retireThrough(Math.min(...ctx.peers.map(p=>p.clock.printTimeAtClock(p.session.clock.sync.lastClock))));
   },invalidateAfter:time=>{assertOwner();target.invalidateAfter(time);},stop:cause=>target.stop(cause)};
   capability=Object.freeze({get names(){assertOwner();return target.names??['fan'];},get status(){assertOwner();return target.status;},register:(value:number,name?:string)=>{assertOwner();return target.register(value,name);},deliver:(...args:Parameters<ClockedBoundaryOutput['deliver']>)=>{assertOwner();return target.deliver(...args);},invalidateAfter:(time:number)=>{assertOwner();target.invalidateAfter(time);},settleScheduled:(signal:AbortSignal)=>{assertOwner();return target.settleScheduled(signal);},retireThrough:(time:number)=>{assertOwner();target.retireThrough(time);},subscribeStop:(listener:(cause:unknown)=>void)=>{assertOwner();return target.subscribeStop(listener);},stop:(cause:unknown)=>target.stop(cause)});
  }
  const byId=new Map(bindings.map(b=>[b.id,b]));
  const sink=new MoveQueueSink(grouped.map((owned,i)=>group.motionQueue(routes[i],owned.map(b=>b.id),t=>owned[0].stepper.clockAt(t))),async outputs=>{
   for(const output of outputs){const b=byId.get(output.id);if(!b)throw new Error('Unknown rebuilt history output');const state=b.history.status,observed=members[b.member].session.clock.sync.lastClock;
    // Retain thirty seconds behind sampled MCU time, never estimated host time.
    // Homing pins prevent this normal-stream policy from dropping its baseline.
    const timeline=timelineFor(routes[b.member]);
    const horizon=timeline?timeline.historyCutoff(observed,30)??state.fromClock:observed-BigInt(Math.ceil(b.stepper.calibration.frequency*30));
    const cutoff=horizon<state.throughClock?horizon:state.throughClock;
    if(cutoff>state.fromClock)b.history.pruneBefore(cutoff);
    b.history.append(output,b.stepper.clockAt(b.stepper.generatedTime));}
   if(o.motorEnable){assertMotorCalibration();await o.motorEnable.beforeSteps(outputs);}
  },motion.printTime);
  const coordinator=new MotionCoordinator(bindings,sink,16*1024*1024,motion.printTime,[group,{assertActive:assertClockCalibration}],clockTimelines?new Map(bindings.map(b=>[b.id,timelineFor(routes[b.member])!])):undefined);
  ownedCoordinator=coordinator;
  const retireClockHistory=():void=>{
   group.assertActive();if(coordinator.status.failed||coordinator.status.retired)throw new Error('Clock retirement requires active motion ownership');
   // Only sampled MCU clocks establish retention, never host extrapolation.
   // Timeline leases may retain additional motion or delayed ADC history.
   for(const owner of clockTimelines??[]){const clock=group.session(owner.id).clock;clock.assertActive();const cutoff=owner.timeline.historyCutoff(clock.sync.lastClock,30);if(cutoff!==undefined)owner.timeline.retireBefore(cutoff);}
  };
  const calibrateAuxiliaryClock=(id:string):boolean=>{
   group.assertActive();if(coordinator.status.failed||coordinator.status.retired)throw new Error('Auxiliary calibration requires active motion ownership');
   if(!auxiliaryMCUs.some(a=>a.id===id))throw new Error('Peripheral calibration requires an auxiliary MCU');
   const owner=clockTimelines?.find(c=>c.id===id),sync=owner?.synchronizer;if(!owner||!sync)throw new Error('Auxiliary MCU has no owned synchronizer');
   const now=serialClock.now(),time=owner.timeline.printTimeAtClock(group.session(id).clock.sync.getClock(now)),candidate=sync.propose(time,now),plan=sync.planPeripheral(candidate,owner.timeline,time+.05,time+1);
   if(!plan)return false;sync.applyPeripheral(candidate,owner.timeline,plan.tick);return true;
  };
  const drain=new CoordinatedMotionDrain(coordinator,sink,group,.25,auxiliaryMCUs);
  const source=new PlannedMotionSource(o.routes,drain,motion.printTime,o.position,65536,output);
  const calibrateMotion=(id:string,generationLimit:number,homingSource?:number):boolean=>{
   assertClockCalibration();const status=coordinator.status,state=source.status,member=routes.indexOf(id);
   if(status.failed||status.retired||status.busy||state.failed||state.busy||(homingSource===undefined?state.retired:!state.retired))throw new Error('Motion calibration requires idle generation ownership');
   if(member<0)throw new Error('Motion calibration requires a motion MCU');
   const owner=clockTimelines?.find(c=>c.id===id),sync=owner?.synchronizer;if(!owner||!sync)throw new Error('Motion MCU has no owned synchronizer');
   if(!Number.isFinite(generationLimit)||generationLimit<status.generatedTime)throw new RangeError('Invalid motion calibration limit');
   if(homingSource===undefined&&(!state.seeded||state.paused))return false;
   const future=Math.max(...bindings.map(b=>b.stepper.scanWindow.future)),limit=Math.min(generationLimit,(homingSource??state.sourceTime)-future-.001,status.generatedTime+.01);
   if(limit<=status.generatedTime)return false;
   const now=serialClock.now(),local=group.session(id).clock.sync;if(owner.timeline.clockAt(status.generatedTime)<=local.getClock(now))return false;
   const candidate=sync.propose(status.generatedTime,now),plan=sync.planShared(candidate,owner.timeline,coordinator,limit);if(!plan||plan.time-status.generatedTime>.01)return false;
   coordinator.generateCalibrationBoundary(plan.time);if(plan.tick<=local.getClock(serialClock.now()))return false;
   sync.applyShared(candidate,owner.timeline,coordinator,grouped[member].map(b=>b.id));return true;
  };
  const calibrateMotionClock=(id:string,generationLimit:number)=>calibrateMotion(id,generationLimit);
  const releaseBoundaryOutput=():BoundaryOutputTransfer|undefined=>{
   if(!context)return;checkMapping();const status=context.target.status;
   if(status.pending||status.busy||status.stopped)throw new Error('Boundary output transfer requires settled requests');
   source.detachBoundaryOutput();context.owner=undefined;const token=Object.freeze({kind:'boundary-output-transfer' as const});transfers.set(token,{context,coordinator});return token;
  };
  const maintain=(generationLimit:number,homingSource?:number)=>{
   const status=coordinator.status;if(status.busy||status.failed||status.retired||source.status.busy)throw new Error('Clock maintenance requires idle generation ownership');assertClockCalibration();
   if(!Number.isFinite(generationLimit)||generationLimit<status.generatedTime)throw new RangeError('Invalid clock maintenance horizon');
   const now=serialClock.now();let retired=false,attempted=0,updated=0;
   for(const owner of clockTimelines??[]){const sync=owner.synchronizer;if(!sync)continue;let cadence=clockCadences.get(sync);if(!cadence){cadence=new CalibrationCadence();clockCadences.set(sync,cadence);}
    const result=cadence.run(now,()=>{if(!retired){retireClockHistory();retired=true;}return routes.includes(owner.id)?calibrateMotion(owner.id,generationLimit,homingSource):calibrateAuxiliaryClock(owner.id);});
    if(result!==undefined){attempted++;if(result)updated++;}
   }
   return {attempted,updated};
  };
  const maintainClocks=(generationLimit:number)=>maintain(generationLimit);
  let homingClockOwner=false;
  /** Privileged handoff after prepareHomingTrajectory has queued all padding.
   * The returned synchronous owner can only use that captured source horizon. */
  const handoffHomingClocks=(endTime:number,sourceUntil:number)=>{
   assertClockCalibration();const state=source.status,status=coordinator.status,future=Math.max(...bindings.map(b=>b.stepper.scanWindow.future));
   if(homingClockOwner||!state.retired||state.seeded||state.paused||state.bufferedMoves||state.sourceTime!==motion.printTime||state.failed||state.busy||status.failed||status.retired||status.busy||status.generatedTime!==motion.printTime||status.committedTime!==motion.printTime||!Number.isFinite(endTime)||!Number.isFinite(sourceUntil)||endTime<=motion.printTime||sourceUntil>=1e12||sourceUntil<=endTime||sourceUntil-endTime<future)throw new Error('Invalid homing clock handoff');
   homingClockOwner=true;
   return (until:number)=>{if(!Number.isFinite(until)||until>endTime)throw new RangeError('Homing clock window exceeds prepared source');return maintain(until,sourceUntil);};
  };
  const clockMaintenanceDue=()=>{const now=serialClock.now();return clockTimelines?.some(c=>c.synchronizer&&(clockCadences.get(c.synchronizer)?.due(now)??true))??false;};
  check();return Object.freeze({group,clockTimelines,auxiliaryMCUs,clockMembers,motion,sink,coordinator,drain,source,motorEnable:o.motorEnable,assertClockCalibration,assertMotorCalibration,retireClockHistory,calibrateAuxiliaryClock,calibrateMotionClock,maintainClocks,handoffHomingClocks,clockMaintenanceDue,boundaryOutput:capability,releaseBoundaryOutput,members:Object.freeze(members),routes:Object.freeze(o.routes.map(r=>Object.freeze({...r}))),assertFutureBaseline:check});
 }catch(error){
  const errors:unknown[]=[error];
  // Close native transports before releasing solver handles. No new producer
  // has received these objects, so there cannot be an active native commit.
  try{await group.stop(error);}catch(stop){errors.push(stop);}
  if(ownedCoordinator)try{await ownedCoordinator.shutdown(error);}catch(stop){errors.push(stop);}
  if(ownedOutput)try{await ownedOutput.stop(error);}catch(stop){errors.push(stop);}
  try{motion.dispose();}catch(disposal){errors.push(disposal);}
  if(errors.length>1)throw new AggregateError(errors,'Rebuilt motion binding and cleanup failed');throw error;
 }
}
