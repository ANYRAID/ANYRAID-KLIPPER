import {MCUGroup} from './mcu-group.ts';
import type {HomingMember} from '../homing/stop-confirmation.ts';
import type {rebuildStoppedMotion} from '../homing/rebuild-motion.ts';
import {MotionCoordinator} from '../motion/coordinator.ts';
import {MoveQueueSink} from '../motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../motion/coordinated-drain.ts';
import {PlannedMotionSource,type PlannedQueue,type SourceBoundaryOutput} from '../motion/planned-motion-source.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {waitForMcuClocks} from '../timing/mcu-clock-barrier.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
type ClockedBoundaryOutput=Omit<SourceBoundaryOutput,'settle'>&{readonly status:{pending:number;busy:boolean;stopped:boolean};register(value:number):number;settleScheduled(signal:AbortSignal):Promise<number>;retireThrough(time:number):void;subscribeStop(listener:(cause:unknown)=>void):()=>void};
const outputOwners=new WeakSet<ClockedBoundaryOutput>();
interface OutputContext {target:ClockedBoundaryOutput;group:MCUGroup;session:HomingMember['session'];clock:ReturnType<typeof snapshotPrintClock>;owner:symbol|undefined;}
/** Opaque, one-use handoff. Only releaseBoundaryOutput can create a valid token. */
export interface BoundaryOutputTransfer {readonly kind:'boundary-output-transfer';}
const transfers=new WeakMap<BoundaryOutputTransfer,{context:OutputContext;coordinator:MotionCoordinator}>();
export interface RebuiltMotionOptions {
 group:MCUGroup;
 /** Exact physical members used by the successful stop/recovery transaction. */
 members:readonly HomingMember[];
 motion:ReturnType<typeof rebuildStoppedMotion>;
 routes:readonly PlannedQueue[];
 position:readonly number[];
 /** Dedicated output with the same print-time calibration as this MCU member. */
 boundaryOutput?:{output:ClockedBoundaryOutput;member:number};
 boundaryTransfer?:BoundaryOutputTransfer;
}
/** Adopt the output of a completed recovery (including reset ACKs) into real
 * group transports, history retention, generation and MCU-time drain. Caller
 * transfers exclusive ownership: failure stops the group and disposes motion.
 * Does not perform stop/reset itself, authorize homing or admit G-code. */
export async function bindRebuiltMotion(o:RebuiltMotionOptions){
 const {group,motion}=o;
 let ownedOutput:ClockedBoundaryOutput|undefined;
 try{
  group.assertActive();
  const ids=group.status.devices.map(d=>d.id),members=o.members.map(m=>Object.freeze({...m,steppers:Object.freeze(m.steppers.map(s=>Object.freeze({...s})))}));
  if(ids.length!==members.length||new Set(members.map(m=>m.session)).size!==members.length)throw new Error('Rebuilt motion requires every physical MCU');
  const routes=members.map(m=>{const id=ids.find(id=>group.session(id)===m.session);if(!id)throw new Error('Rebuilt member does not belong to MCU group');m.session.assertCommandQueue(m.queue);return id;});
  const bindings=motion.bindings;
  if(!bindings.length||bindings.some(b=>!Number.isInteger(b.member)||!members[b.member]||b.stepper.generatedTime!==motion.printTime))throw new Error('Invalid rebuilt motion baseline');
  const grouped=members.map((m,i)=>{
   const owned=bindings.filter(b=>b.member===i);
   if(!owned.length||owned.length!==m.steppers.length||new Set(owned.map(b=>b.oid)).size!==owned.length||owned.some(b=>!m.steppers.some(s=>s.oid===b.oid&&s.inverted===b.inverted)))throw new Error('Incomplete rebuilt MCU bindings');
   const calibration=owned[0].stepper.calibration;
   if(owned.some(b=>b.stepper.calibration.offset!==calibration.offset||b.stepper.calibration.frequency!==calibration.frequency))throw new Error('Rebuilt MCU clocks differ');
   return owned;
  });
  if(o.routes.length!==motion.queues.length||new Set(o.routes.map(r=>r.queue)).size!==o.routes.length)throw new Error('Rebuilt source queue coverage differs');
  for(const r of o.routes){const q=motion.queues.find(q=>q.queue===r.queue),p=r.extrusionAxis===undefined?o.position.slice(0,3):[o.position[r.extrusionAxis],0,0];if(!q||q.position.some((v,i)=>v!==p[i]))throw new Error('Rebuilt source coordinate differs from recovery');}
  const calibrations=bindings.map(b=>b.stepper.calibration);
  const check=()=>{group.assertActive();for(const [i,b] of bindings.entries()){const current=b.stepper.calibration,saved=calibrations[i];if(current.offset!==saved.offset||current.frequency!==saved.frequency)throw new Error('Rebuilt motion calibration changed before start');}const now=serialClock.now();for(const [i,owned] of grouped.entries())if(owned[0].stepper.clockAt(motion.printTime)<=members[i].session.clock.sync.getClock(now))throw new Error('Rebuilt motion baseline expired before binding');};
  check();
  let output:SourceBoundaryOutput|undefined,context:OutputContext|undefined,capability:ClockedBoundaryOutput|undefined;const owner=Symbol('boundary output owner');let checkMapping=()=>{};
  if(o.boundaryOutput&&o.boundaryTransfer)throw new Error('Choose initial output or output transfer');
  if(o.boundaryOutput||o.boundaryTransfer){
   let member:number;
   if(o.boundaryTransfer){
    const transfer=transfers.get(o.boundaryTransfer);if(!transfer)throw new Error('Invalid or consumed boundary output transfer');
    context=transfer.context;ownedOutput=context.target;member=members.findIndex(m=>m.session===context!.session);
    if(context.group!==group||context.owner!==undefined||member<0||!transfer.coordinator.retirementComplete)throw new Error('Boundary output transfer requires retired motion on the same MCU group');
    const next=grouped[member][0].stepper.calibration;if(next.offset!==context.clock.offset||next.frequency!==context.clock.frequency)throw new Error('Boundary output transfer clock mapping differs');
    transfers.delete(o.boundaryTransfer);
   }else{
    const {output:target,member:index}=o.boundaryOutput!;member=index;
    if(!Number.isInteger(member)||!members[member]||outputOwners.has(target)||target.status.stopped||target.status.busy)throw new Error('Invalid boundary output MCU or ownership');
    outputOwners.add(target);ownedOutput=target;context={target,group,session:members[member].session,clock:snapshotPrintClock(grouped[member][0].stepper.calibration),owner:undefined};
    let offGroup=()=>{},offOutput=()=>{};
    offGroup=group.subscribeStop(cause=>{void target.stop(cause).catch(()=>{});offGroup();offOutput();});
    offOutput=target.subscribeStop(cause=>{void group.stop(cause).catch(()=>{});});
   }
   const ctx=context,target=ctx.target,binding=grouped[member][0],mapping=ctx.clock;
   if(target.status.stopped||target.status.busy||o.boundaryTransfer&&target.status.pending)throw new Error('Boundary output is not available');ctx.owner=owner;
   const assertOwner=()=>{group.assertActive();if(ctx.owner!==owner)throw new Error('Boundary output ownership transferred');};
   checkMapping=()=>{
    assertOwner();const current=binding.stepper.calibration;
    if(current.offset!==mapping.offset||current.frequency!==mapping.frequency)throw new Error('Boundary output clock calibration changed');
   };
   output={deliver:async(boundaries,horizon,signal)=>{
    checkMapping();
    target.retireThrough(mapping.printTimeAtClock(ctx.session.clock.sync.lastClock));
    await target.deliver(boundaries,horizon,signal);group.assertActive();
   },settle:async signal=>{
    checkMapping();const horizon=await target.settleScheduled(signal);signal.throwIfAborted();checkMapping();
    if(!Number.isFinite(horizon)||horizon<0)throw new Error('Invalid boundary output settlement horizon');
    await waitForMcuClocks([{clock:ctx.session.clock,tick:mapping.clockAt(horizon)}],signal);
    signal.throwIfAborted();checkMapping();target.retireThrough(mapping.printTimeAtClock(ctx.session.clock.sync.lastClock));
   },invalidateAfter:time=>{assertOwner();target.invalidateAfter(time);},stop:cause=>target.stop(cause)};
   capability=Object.freeze({get status(){assertOwner();return target.status;},register:(value:number)=>{assertOwner();return target.register(value);},deliver:(...args:Parameters<ClockedBoundaryOutput['deliver']>)=>{assertOwner();return target.deliver(...args);},invalidateAfter:(time:number)=>{assertOwner();target.invalidateAfter(time);},settleScheduled:(signal:AbortSignal)=>{assertOwner();return target.settleScheduled(signal);},retireThrough:(time:number)=>{assertOwner();target.retireThrough(time);},subscribeStop:(listener:(cause:unknown)=>void)=>{assertOwner();return target.subscribeStop(listener);},stop:(cause:unknown)=>target.stop(cause)});
  }
  const byId=new Map(bindings.map(b=>[b.id,b]));
  const sink=new MoveQueueSink(grouped.map((owned,i)=>group.motionQueue(routes[i],owned.map(b=>b.id),t=>owned[0].stepper.clockAt(t))),async outputs=>{
   for(const output of outputs){const b=byId.get(output.id);if(!b)throw new Error('Unknown rebuilt history output');const state=b.history.status,observed=members[b.member].session.clock.sync.lastClock;
    // Retain thirty seconds behind sampled MCU time, never estimated host time.
    // Homing pins prevent this normal-stream policy from dropping its baseline.
    const horizon=observed-BigInt(Math.ceil(b.stepper.calibration.frequency*30));
    const cutoff=horizon<state.throughClock?horizon:state.throughClock;
    if(cutoff>state.fromClock)b.history.pruneBefore(cutoff);
    b.history.append(output,b.stepper.clockAt(b.stepper.generatedTime));}
  },motion.printTime);
  const coordinator=new MotionCoordinator(bindings,sink,16*1024*1024,motion.printTime,[group]);
  const drain=new CoordinatedMotionDrain(coordinator,sink,group);
  const source=new PlannedMotionSource(o.routes,drain,motion.printTime,o.position,65536,output);
  const releaseBoundaryOutput=():BoundaryOutputTransfer|undefined=>{
   if(!context)return;checkMapping();const status=context.target.status;
   if(status.pending||status.busy||status.stopped)throw new Error('Boundary output transfer requires settled requests');
   source.detachBoundaryOutput();context.owner=undefined;const token=Object.freeze({kind:'boundary-output-transfer' as const});transfers.set(token,{context,coordinator});return token;
  };
  check();return Object.freeze({group,motion,sink,coordinator,drain,source,boundaryOutput:capability,releaseBoundaryOutput,members:Object.freeze(members),routes:Object.freeze(o.routes.map(r=>Object.freeze({...r}))),assertFutureBaseline:check});
 }catch(error){
  const errors:unknown[]=[error];
  // Close native transports before releasing solver handles. No new producer
  // has received these objects, so there cannot be an active native commit.
  try{await group.stop(error);}catch(stop){errors.push(stop);}
  if(ownedOutput)try{await ownedOutput.stop(error);}catch(stop){errors.push(stop);}
  try{motion.dispose();}catch(disposal){errors.push(disposal);}
  if(errors.length>1)throw new AggregateError(errors,'Rebuilt motion binding and cleanup failed');throw error;
 }
}
