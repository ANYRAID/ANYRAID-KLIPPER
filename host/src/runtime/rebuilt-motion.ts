import {MCUGroup} from './mcu-group.ts';
import type {HomingMember} from '../homing/stop-confirmation.ts';
import type {rebuildStoppedMotion} from '../homing/rebuild-motion.ts';
import {MotionCoordinator} from '../motion/coordinator.ts';
import {MoveQueueSink} from '../motion/move-queue-sink.ts';
import {CoordinatedMotionDrain} from '../motion/coordinated-drain.ts';
import {PlannedMotionSource,type PlannedQueue} from '../motion/planned-motion-source.ts';
import {serialClock} from '../protocol/serial-queue.ts';
export interface RebuiltMotionOptions {
 group:MCUGroup;
 /** Exact physical members used by the successful stop/recovery transaction. */
 members:readonly HomingMember[];
 motion:ReturnType<typeof rebuildStoppedMotion>;
 routes:readonly PlannedQueue[];
 position:readonly number[];
}
/** Adopt the output of a completed recovery (including reset ACKs) into real
 * group transports, history retention, generation and MCU-time drain. Caller
 * transfers exclusive ownership: failure stops the group and disposes motion.
 * Does not perform stop/reset itself, authorize homing or admit G-code. */
export async function bindRebuiltMotion(o:RebuiltMotionOptions){
 const {group,motion}=o;
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
  const source=new PlannedMotionSource(o.routes,drain,motion.printTime,o.position);
  check();return Object.freeze({motion,sink,coordinator,drain,source,members:Object.freeze(members),routes:Object.freeze(o.routes.map(r=>Object.freeze({...r}))),assertFutureBaseline:check});
 }catch(error){
  const errors:unknown[]=[error];
  // Close native transports before releasing solver handles. No new producer
  // has received these objects, so there cannot be an active native commit.
  try{await group.stop(error);}catch(stop){errors.push(stop);}
  try{motion.dispose();}catch(disposal){errors.push(disposal);}
  if(errors.length>1)throw new AggregateError(errors,'Rebuilt motion binding and cleanup failed');throw error;
 }
}
