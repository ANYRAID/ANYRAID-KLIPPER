import type {TmcSensorlessMode} from '../drivers/tmc-sensorless.ts';
import type {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import type {prepareHomingTrajectory} from './prepare-trajectory.ts';
import type {HomingMember} from './stop-confirmation.ts';
import type {StoppedEmitter,rebuildStoppedMotion} from './rebuild-motion.ts';
import type {EndstopProtocol} from '../inputs/endstop.ts';
import type {TriggerSyncProtocol} from '../inputs/trsync.ts';
import type {ArmedHomingGroup} from './move-execution.ts';
import {homingEndstopSampling,type EndstopActuator} from './endstop-rate.ts';
export interface HomingGroupConfig {
 readonly sensorless?:TmcSensorlessMode;
 readonly members:readonly {physicalMember:number;trigger:TriggerSyncProtocol;emitters:readonly string[]}[];
 readonly primary:number;readonly endstop:EndstopProtocol;readonly expireTimeout:number;
}
/** Build independent trigger groups from a prepared, exclusively owned native
 * generation. No commands or native dispatch handles are created. The owner
 * must stop its generation if planning/arming fails. Every bound actuator must
 * belong to exactly one group, including idle actuators required for recovery. */
export function planHomingGroups(g:Awaited<ReturnType<typeof bindRebuiltMotion>>,emitters:readonly StoppedEmitter[],trajectory:Awaited<ReturnType<typeof prepareHomingTrajectory>>,configs:readonly HomingGroupConfig[]){
 g.assertFutureBaseline();const physicalMembers=g.members;
 if(!g.source.status.retired||g.coordinator.status.generatedTime!==trajectory.startTime||trajectory.startTime!==g.motion.printTime||!configs.length||configs.length>16||emitters.length!==g.motion.bindings.length)throw new Error('Invalid prepared homing group ownership');
 const byId=new Map(g.motion.bindings.map(b=>[b.id,b])),descriptors=new Map(emitters.map(e=>[e.id,e]));
 if(descriptors.size!==emitters.length)throw new Error('Duplicate homing emitter descriptor');
 const claimed=new Set<string>(),roles=new Map<HomingMember['session'],Set<number>>(),mapping=new Map<string,{physical:number;logical:number;oid:number;inverted:boolean}>();
 const groups:ArmedHomingGroup[]=[],logicalEmitters:StoppedEmitter[]=[],histories:{member:number;oid:number;history:typeof g.motion.bindings[number]['history']}[]=[];let logical=0;
 for(const config of configs){
  if(!config.members.length||config.members.length>16||new Set(config.members.map(m=>m.physicalMember)).size!==config.members.length||!Number.isInteger(config.primary)||config.primary<0||config.primary>=config.members.length||!Number.isFinite(config.expireTimeout)||config.expireTimeout<=0)throw new Error('Invalid homing group configuration');
  const starts:bigint[]=[],actuators:EndstopActuator[]=[];let primaryStepper:typeof g.motion.bindings[number]['stepper']|undefined;
  const members=config.members.map((entry,local)=>{
   const physical=physicalMembers[entry.physicalMember];
   if(!Number.isInteger(entry.physicalMember)||!physical||!entry.emitters.length||logical>=128)throw new Error('Invalid physical homing member');
   physical.session.assertCommandQueue(physical.queue);entry.trigger.assertDictionary(physical.session.dictionary);
   const occupied=roles.get(physical.session)??new Set<number>();roles.set(physical.session,occupied);
   const claim=(oid:number)=>{if(occupied.has(oid))throw new Error('Homing OID roles overlap');occupied.add(oid);};claim(entry.trigger.oid);
   if(local===config.primary){config.endstop.assertDictionary(physical.session.dictionary);claim(config.endstop.oid);}
   const index=logical++,owned=entry.emitters.map(id=>{
    const b=byId.get(id),e=descriptors.get(id);
    if(!b||!e||claimed.has(id)||b.member!==entry.physicalMember||e.member!==b.member||e.settings.oid!==b.oid||!!e.settings.invertDirection!==b.inverted||!physical.steppers.some(s=>s.oid===b.oid&&s.inverted===b.inverted))throw new Error('Homing emitter ownership differs');
    claimed.add(id);claim(b.oid);mapping.set(id,{physical:b.member,logical:index,oid:b.oid,inverted:b.inverted});
    const clock=b.stepper.clockAt(trajectory.startTime);if(b.history.status.throughClock!==clock)throw new Error('Homing history baseline differs');
    logicalEmitters.push({...structuredClone(e),member:index});histories.push({member:index,oid:b.oid,history:b.history});
    if(g.routes.some(r=>r.queue===b.queue&&r.extrusionAxis===undefined)){actuators.push({stepper:b.stepper,stepDistance:b.position.state.stepDistance});if(local===config.primary&&!primaryStepper)primaryStepper=b.stepper;}
    return b;
   });
   const clock=owned[0].stepper.clockAt(trajectory.startTime);if(owned.some(b=>b.stepper.clockAt(trajectory.startTime)!==clock))throw new Error('Homing member clock mapping differs');starts.push(clock);
   return {...physical,trigger:entry.trigger,steppers:owned.map(b=>({oid:b.oid,inverted:b.inverted}))};
  });
  if(!primaryStepper)throw new Error('Primary homing MCU needs a participating XYZ actuator');
  const sampling=homingEndstopSampling(config.endstop,primaryStepper,members[config.primary].trigger.oid,trajectory.startTime,trajectory.startPosition,trajectory.endPosition,trajectory.speed,actuators);
  groups.push({members,primary:config.primary,endstop:config.endstop,sampling,startClocks:starts,expireTimeout:config.expireTimeout});
 }
 if(claimed.size!==byId.size)throw new Error('Homing groups omit bound actuators');
 return Object.freeze({groups:Object.freeze(groups),emitters:Object.freeze(logicalEmitters),histories:Object.freeze(histories),
  /** Recovery uses group-local logical members. Restore physical MCU indices
   * before binding the recovered result back into ordinary group transports. */
  restorePhysicalMembers(motion:ReturnType<typeof rebuildStoppedMotion>){
   if(motion.bindings.length!==mapping.size||new Set(motion.bindings.map(b=>b.id)).size!==mapping.size)throw new Error('Recovered homing binding coverage differs');
   const bindings=motion.bindings.map(b=>{const m=mapping.get(b.id);if(!m||b.member!==m.logical||b.oid!==m.oid||b.inverted!==m.inverted)throw new Error('Recovered homing member differs');return Object.freeze({...b,member:m.physical});});
   return Object.freeze({...motion,bindings:Object.freeze(bindings)});
  }});
}
