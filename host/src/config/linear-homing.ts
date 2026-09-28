import type {TmcSensorlessMode} from '../drivers/tmc-sensorless.ts';
import type {compileConfiguredHardware} from './hardware.ts';
import type {ConfiguredLinearHardware} from './linear-motion.ts';
import type {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import type {HomingGroupConfig} from '../homing/group-plan.ts';
export interface ConfiguredHomingGroup {section:string;emitters:readonly string[];expireTimeout?:number;}
export interface ConfiguredLinearHoming {
 carriages?:{emitterIds:readonly [string,string];homing:readonly [readonly ConfiguredHomingGroup[],readonly ConfiguredHomingGroup[]]};
 probe?:readonly ConfiguredHomingGroup[];
 kinematicIds:ConfiguredLinearHardware['kinematicIds'];
 homing:readonly [readonly ConfiguredHomingGroup[],readonly ConfiguredHomingGroup[],readonly ConfiguredHomingGroup[]];
}
/** Resolve configured GPIO/trsync ownership into the compact motion member map.
 * Every axis must explicitly cover all motors, including idle extrusion motors.
 * No IO, resource allocation, homing authority or invented trigger objects. */
export function compileLinearHoming(plan:ReturnType<typeof compileConfiguredHardware>,generation:Awaited<ReturnType<typeof bindRebuiltMotion>>,request:ConfiguredLinearHoming,sensorless:ReadonlyMap<string,TmcSensorlessMode>=new Map()):Omit<ConfiguredLinearHardware,'generation'|'emitters'|'canExtrude'>{
 if(request.homing.length!==3)throw new Error('Three configured homing axes required');
 const bindings=generation.motion.bindings;
 if(request.kinematicIds.length!==3||new Set(request.kinematicIds).size!==3||request.kinematicIds.some(id=>!bindings.some(b=>b.id===id&&generation.routes.some(r=>r.queue===b.queue&&r.extrusionAxis===undefined))))throw new Error('Invalid configured homing rail representatives');
 if(request.carriages&&(request.carriages.emitterIds.length!==2||new Set(request.carriages.emitterIds).size!==2||request.carriages.homing.length!==2||request.carriages.emitterIds.some(id=>!bindings.some(b=>b.id===id&&generation.routes.some(r=>r.queue===b.queue&&r.extrusionAxis===undefined)))))throw new Error('Invalid configured carriage homing ownership');
 const compileGroups=(groups:readonly ConfiguredHomingGroup[])=>compileHomingGroups(plan,generation,groups,sensorless);
 const groupsByAxis=request.homing.map(compileGroups),probeGroups=request.probe?compileGroups(request.probe):undefined;
 const carriages=request.carriages?{emitterIds:Object.freeze([...request.carriages.emitterIds]) as readonly [string,string],groups:Object.freeze(request.carriages.homing.map(compileGroups)) as unknown as NonNullable<ConfiguredLinearHardware['carriages']>['groups']}:undefined;
 const carriageEndstopNames=request.carriages?Object.freeze(request.carriages.homing.map(groups=>Object.freeze(groups.map(g=>g.section)))) as unknown as ConfiguredLinearHardware['carriageEndstopNames']:undefined;
 return Object.freeze({carriages,carriageEndstopNames,...(probeGroups?{probeGroups}:{}),kinematicIds:Object.freeze([...request.kinematicIds]) as ConfiguredLinearHardware['kinematicIds'],groupsByAxis:Object.freeze(groupsByAxis) as unknown as ConfiguredLinearHardware['groupsByAxis'],endstopNames:Object.freeze(request.homing.map(groups=>Object.freeze(groups.map(g=>g.section)))) as unknown as ConfiguredLinearHardware['endstopNames']});
}

/** Validate one simultaneous set of independently stopping endstop groups. */
export function compileHomingGroups(plan:ReturnType<typeof compileConfiguredHardware>,generation:Awaited<ReturnType<typeof bindRebuiltMotion>>,groups:readonly ConfiguredHomingGroup[],sensorless:ReadonlyMap<string,TmcSensorlessMode>=new Map()):readonly HomingGroupConfig[]{
 const bindings=generation.motion.bindings,memberByMCU=new Map(plan.configurations.map(c=>[c.mcu,generation.members.findIndex(m=>m.session===c.session)]));

  if(!groups.length||groups.length>16||new Set(groups.map(g=>g.section)).size!==groups.length)throw new Error('Invalid configured homing groups');
  const claimed=new Set<string>();
  const result=groups.map(g=>{
   const h=plan.homing.find(h=>h.section===g.section),timeout=g.expireTimeout??.25;
   if(!h||!g.emitters.length||!Number.isFinite(timeout)||timeout<=0)throw new Error('Unknown configured homing section or timeout');
   const owned=g.emitters.map(id=>{const b=bindings.find(b=>b.id===id);if(!b||claimed.has(id))throw new Error('Unknown or duplicate configured homing emitter');claimed.add(id);return b;});
   const needed=new Set(owned.map(b=>b.member));
   const members=h.triggers.flatMap(t=>{
    const physicalMember=memberByMCU.get(t.mcu);if(physicalMember===undefined||physicalMember<0||!needed.has(physicalMember))return [];
    return [Object.freeze({physicalMember,trigger:t.protocol,emitters:Object.freeze(owned.filter(b=>b.member===physicalMember).map(b=>b.id))})];
   });
   if(members.length!==needed.size||new Set(members.map(m=>m.physicalMember)).size!==needed.size)throw new Error('Configured homing trigger coverage differs');
   const primary=members.findIndex(m=>m.physicalMember===memberByMCU.get(h.mcu));
   if(primary<0||!owned.some(b=>b.member===members[primary].physicalMember&&generation.routes.some(r=>r.queue===b.queue&&r.extrusionAxis===undefined)))throw new Error('Configured homing GPIO requires a kinematic motor member');
   const mode=h.sensorless?sensorless.get(h.sensorless.section):undefined;if(h.sensorless&&!mode)throw new Error('Sensorless homing driver is not initialized');
   return Object.freeze({members:Object.freeze(members),primary,endstop:h.endstop,expireTimeout:timeout,sensorless:mode}) satisfies HomingGroupConfig;
  });
  if(claimed.size!==bindings.length)throw new Error('Configured homing omits motors');
  return Object.freeze(result);
}
