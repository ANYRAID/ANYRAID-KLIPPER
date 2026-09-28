import {DeltaKinematics} from '../kinematics/delta.ts';
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
 mode?:'home'|'probe';
 onTriggered?:(signal:AbortSignal)=>Promise<void>;
 generation:Awaited<ReturnType<typeof bindRebuiltMotion>>;kinematics:LinearKinematics;
 emitters:readonly StoppedEmitter[];groups:readonly HomingGroupConfig[];
 /** Representative rail motors, ordered as calcPosition's A/B/C inputs. */
 kinematicIds:readonly [string,string,string];
}
export interface DeltaSeekOptions extends Omit<LinearSeekOptions,'kinematics'> {kinematics:DeltaKinematics;}
/** One actual seek and generation adoption. The G28 owner still decides first/
 * second pass, checks missing hits, sequences retract, and grants authority.
 * No independent producer/calibration may operate while this object owns it. */
export class LinearHomingSeek {
 #o:Omit<LinearSeekOptions,'kinematics'>&{kinematics:LinearKinematics|DeltaKinematics};#started=false;#cleanupPending=false;#cleanupError:unknown;
 constructor(o:Omit<LinearSeekOptions,'kinematics'>&{kinematics:LinearKinematics|DeltaKinematics}){this.#o={...o,emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],groups:o.groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))};}
 get status(){return {started:this.#started,cleanupPending:this.#cleanupPending,cleanupError:this.#cleanupError};}
 async run(target:readonly number[],speed:number,axis:Axis,signal:AbortSignal,timeoutMs=60000){
  if(this.#started)throw new Error('Linear homing seek is single use');this.#started=true;
  const o=this.#o,g=o.generation,mode=o.mode??'home';let executor:HomingMoveExecution|undefined,motion:Awaited<ReturnType<HomingMoveExecution['run']>>['motion']|undefined;
  try{
   signal.throwIfAborted();if(mode!=='home'&&mode!=='probe')throw new Error('Invalid seek mode');
   if(o.kinematics instanceof DeltaKinematics){
    const geometry=o.kinematics.solverGeometry;
    if(new Set(o.kinematicIds).size!==3||o.kinematicIds.some((id,i)=>{
     const actual=o.emitters.find(e=>e.id===id)?.mode,expected=geometry[i];
     return typeof actual!=='object'||actual.kind!=='delta'||actual.armLength!==expected.armLength||actual.towerX!==expected.towerX||actual.towerY!==expected.towerY;
    }))throw new Error('Delta homing rail solvers differ from kinematics');
   }else{
    const expected=o.kinematics.solverModes;
    if(new Set(o.kinematicIds).size!==3||o.kinematicIds.some((id,i)=>o.emitters.find(e=>e.id===id)?.mode!==expected[i]))throw new Error('Linear homing rail solvers differ from kinematics');
   }
   const routes=g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}));
   const emitters=recoveryEmitters(g.motion.bindings,o.emitters),boundaryTransfer=g.releaseBoundaryOutput();
   const prepared=await prepareHomingTrajectory(g,o.kinematics,target,speed,axis,signal,mode),plan=planHomingGroups(g,emitters,prepared,o.groups);
   // Capture target motor coordinates while the old native solvers are alive.
   const actuators=plan.emitters.map(e=>{const b=g.motion.bindings.find(b=>b.id===e.id)!,route=routes.find(r=>r.id===e.queueId);if(!route)throw new Error('Missing homing queue route');const reference=mode==='probe'?prepared.startPosition:prepared.endPosition,p=route.extrusionAxis===undefined?reference.slice(0,3):[reference[route.extrusionAxis],0,0];return {id:b.id,member:e.member,oid:b.oid,commanded:b.stepper.coordinatePosition(p[0],p[1],p[2]),stepDistance:b.position.state.stepDistance,extra:route.extrusionAxis!==undefined};});
   const movingSteppers=Object.freeze(actuators.filter(a=>!a.extra&&g.motion.bindings.find(b=>b.id===a.id)!.stepper.coordinatePosition(...prepared.endPosition.slice(0,3) as [number,number,number])!==g.motion.bindings.find(b=>b.id===a.id)!.stepper.coordinatePosition(...prepared.startPosition.slice(0,3) as [number,number,number])).map(a=>Object.freeze({member:a.member,oid:a.oid})));
   let halt:readonly number[]|undefined,trigger:readonly number[]|undefined;
   const clockTimelines=g.clockTimelines?new Map(g.motion.bindings.map(b=>[b.id,g.clockMembers.find(m=>m.session===g.members[b.member].session)!.timeline!])):undefined;
   executor=new HomingMoveExecution({...plan,onTriggered:o.onTriggered,clockTimelines,prepareWindow:clockTimelines?until=>{prepared.prepareWindow(until);}:undefined,coordinator:g.coordinator,bindings:g.motion.bindings,startTime:prepared.startTime,endTime:prepared.endTime,timeoutMs,locate:readback=>{
    for(const a of actuators)if(a.extra){const offset=readback.offsets.find(p=>p.member===a.member&&p.oid===a.oid);if(!offset||offset.triggerOffset!==0n||offset.haltOffset!==0n)throw new Error('Unexpected extra-axis movement during homing');}
    const located=homingToolheadPositions({mode,actuators,offsets:readback.offsets,reference:mode==='probe'?prepared.startPosition:prepared.endPosition,calculate:positions=>o.kinematics.calcPosition([positions.get(o.kinematicIds[0])!,positions.get(o.kinematicIds[1])!,positions.get(o.kinematicIds[2])!])});halt=located.halt;trigger=located.trigger;
    const now=serialClock.now(),printTime=Math.max(...g.clockMembers.map(m=>m.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))))+.2;
    return {queues:routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?halt!.slice(0,3):[halt![r.extrusionAxis],0,0]) as [number,number,number]})),printTime};
   }});
   const result=await executor.run(signal);motion=result.motion;signal.throwIfAborted();if(!halt||!trigger)throw new Error('Missing seek coordinates');if(mode==='probe'&&result.missingHits.length)throw new Error('Probe did not trigger');
   motion=plan.restorePhysicalMembers(motion);
   const next=await bindRebuiltMotion({group:g.group,clockTimelines:g.clockTimelines,members:g.members,auxiliaryMCUs:g.auxiliaryMCUs,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position:halt,boundaryTransfer,motorEnable:g.motorEnable});
   signal.throwIfAborted();return Object.freeze({...result,triggerCounts:Object.freeze(actuators.map(a=>{const p=result.offsets.find(p=>p.member===a.member&&p.oid===a.oid);if(!p)throw new Error('Missing phase trigger mapping');return Object.freeze({id:a.id,trigger:p.trigger});})),movingSteppers,motion,generation:next,position:halt,triggerPosition:trigger});
  }catch(error){
   const errors:unknown[]=[error];this.#cleanupPending=true;
   const cleanup=g.drain.stop(error).catch(e=>{this.#cleanupError=e;throw e;}).finally(()=>{this.#cleanupPending=false;});void cleanup.catch(()=>{});
   const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error('Linear seek cleanup timed out')),5000);
   try{await observeRetirement(cleanup,deadline.signal);}catch(stop){errors.push(stop);}finally{clearTimeout(timer);}
   try{motion?.dispose();}catch(disposal){errors.push(disposal);}if(errors.length>1)throw new AggregateError(errors,'Linear seek and cleanup failed');throw error;
  }finally{executor?.dispose();}
 }
}
