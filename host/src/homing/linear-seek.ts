import {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {LinearKinematics,type Axis} from '../kinematics/linear.ts';
import type {StoppedEmitter} from './rebuild-motion.ts';
import {prepareHomingTrajectory} from './prepare-trajectory.ts';
import {planHomingGroups,type HomingGroupConfig} from './group-plan.ts';
import {HomingMoveExecution} from './move-execution.ts';
import {homingToolheadPositions} from './toolhead-position.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {observeRetirement} from '../motion/retired.ts';
import {recoveryEmitters} from './recovery-emitters.ts';
export interface LinearSeekOptions {
 generation:Awaited<ReturnType<typeof bindRebuiltMotion>>;kinematics:LinearKinematics;
 emitters:readonly StoppedEmitter[];groups:readonly HomingGroupConfig[];
 /** Representative rail motors, ordered as calcPosition's A/B/C inputs. */
 kinematicIds:readonly [string,string,string];
}
/** One actual seek and generation adoption. The G28 owner still decides first/
 * second pass, checks missing hits, sequences retract, and grants authority.
 * No independent producer/calibration may operate while this object owns it. */
export class LinearHomingSeek {
 #o:LinearSeekOptions;#started=false;#cleanupPending=false;#cleanupError:unknown;
 constructor(o:LinearSeekOptions){this.#o={...o,emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],groups:o.groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))};}
 get status(){return {started:this.#started,cleanupPending:this.#cleanupPending,cleanupError:this.#cleanupError};}
 async run(target:readonly number[],speed:number,axis:Axis,signal:AbortSignal,timeoutMs=60000){
  if(this.#started)throw new Error('Linear homing seek is single use');this.#started=true;
  const o=this.#o,g=o.generation;let executor:HomingMoveExecution|undefined,motion:Awaited<ReturnType<HomingMoveExecution['run']>>['motion']|undefined;
  try{
   signal.throwIfAborted();
   const expected=o.kinematics.kind==='cartesian'?['x','y','z']:o.kinematics.kind==='corexy'?['corexy+','corexy-','z']:['corexz+','y','corexz-'];
   if(new Set(o.kinematicIds).size!==3||o.kinematicIds.some((id,i)=>o.emitters.find(e=>e.id===id)?.mode!==expected[i]))throw new Error('Linear homing rail solvers differ from kinematics');
   const routes=g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}));
   const emitters=recoveryEmitters(g.motion.bindings,o.emitters),boundaryTransfer=g.releaseBoundaryOutput();
   const prepared=await prepareHomingTrajectory(g,o.kinematics,target,speed,axis,signal),plan=planHomingGroups(g,emitters,prepared,o.groups);
   // Capture target motor coordinates while the old native solvers are alive.
   const actuators=plan.emitters.map(e=>{const b=g.motion.bindings.find(b=>b.id===e.id)!,route=routes.find(r=>r.id===e.queueId);if(!route)throw new Error('Missing homing queue route');const p=route.extrusionAxis===undefined?prepared.endPosition.slice(0,3):[prepared.endPosition[route.extrusionAxis],0,0];return {id:b.id,member:e.member,oid:b.oid,commanded:b.stepper.coordinatePosition(p[0],p[1],p[2]),stepDistance:b.position.state.stepDistance,extra:route.extrusionAxis!==undefined};});
   const movingSteppers=Object.freeze(actuators.filter(a=>!a.extra&&a.commanded!==g.motion.bindings.find(b=>b.id===a.id)!.stepper.coordinatePosition(...prepared.startPosition.slice(0,3) as [number,number,number])).map(a=>Object.freeze({member:a.member,oid:a.oid})));
   let halt:readonly number[]|undefined;
   executor=new HomingMoveExecution({...plan,coordinator:g.coordinator,bindings:g.motion.bindings,startTime:prepared.startTime,endTime:prepared.endTime,timeoutMs,locate:readback=>{
    for(const a of actuators)if(a.extra){const offset=readback.offsets.find(p=>p.member===a.member&&p.oid===a.oid);if(!offset||offset.triggerOffset!==0n||offset.haltOffset!==0n)throw new Error('Unexpected extra-axis movement during homing');}
    halt=homingToolheadPositions({mode:'home',actuators,offsets:readback.offsets,reference:prepared.endPosition,calculate:positions=>o.kinematics.calcPosition(o.kinematicIds.map(id=>positions.get(id)!))}).halt;
    const now=serialClock.now(),printTime=Math.max(...g.members.map((m,i)=>g.motion.bindings.find(b=>b.member===i)!.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))))+.2;
    return {queues:routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?halt!.slice(0,3):[halt![r.extrusionAxis],0,0]) as [number,number,number]})),printTime};
   }});
   const result=await executor.run(signal);motion=result.motion;signal.throwIfAborted();if(!halt)throw new Error('Missing homing halt coordinates');
   motion=plan.restorePhysicalMembers(motion);
   const next=await bindRebuiltMotion({group:g.group,members:g.members,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position:halt,boundaryTransfer});
   signal.throwIfAborted();return Object.freeze({...result,movingSteppers,motion,generation:next,position:halt});
  }catch(error){
   const errors:unknown[]=[error];this.#cleanupPending=true;
   const cleanup=g.drain.stop(error).catch(e=>{this.#cleanupError=e;throw e;}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Linear seek cleanup timed out')),5000);
   try{await observeRetirement(cleanup,deadline.signal);}catch(stop){errors.push(stop);}finally{clearTimeout(timer);}
   try{motion?.dispose();}catch(disposal){errors.push(disposal);}if(errors.length>1)throw new AggregateError(errors,'Linear seek and cleanup failed');throw error;
  }finally{executor?.dispose();}
 }
}
