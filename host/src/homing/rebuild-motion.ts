import {TrapQueue} from '../motion/trap-queue.ts';
import {StepperPosition} from '../motion/stepper-position.ts';
import {StepHistory} from '../motion/step-history.ts';
import type {StepCompressorSettings,StepperKinematics} from '../motion/step-compressor.ts';
import type {MotionBinding} from '../motion/coordinator.ts';
import type {Shaper} from '../motion/shaper.ts';
import type {HomingStopResult} from './stop-confirmation.ts';
export interface StoppedQueue {readonly id:string;readonly position:readonly [number,number,number];}
export interface StoppedEmitter {
 readonly id:string;readonly queueId:string;readonly member:number;
 readonly settings:Omit<StepCompressorSettings,'initialClock'>;
 readonly mode:StepperKinematics;readonly rotationDistance:number;readonly stepsPerRotation:number;
 readonly shapers?:Partial<Record<'x'|'y'|'z',Shaper>>;
 readonly pressureAdvance?:{advance:number;smoothTime:number};
}
export interface RebuiltBinding extends MotionBinding {
 readonly member:number;readonly oid:number;readonly inverted:boolean;readonly position:StepperPosition;readonly history:StepHistory;
}
/** Host-only reconciliation after stop confirmation. The owner MUST already
 * fence source producers, coordinator and transport commits. This synchronous
 * operation cannot cancel packets already accepted by a sink. Supply every
 * retired binding and every affected stepper, including coupled axes.
 *
 * Prepare all new resources first; invalid input leaves old resources intact.
 * Retirement errors dispose the replacement and are terminal for the old set.
 * No reset_step_clock, homing authority or firmware motion is issued here. */
export function rebuildStoppedMotion(result:HomingStopResult,old:readonly MotionBinding[],queues:readonly StoppedQueue[],emitters:readonly StoppedEmitter[],printTime:number){
 const validId=(id:string)=>typeof id==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(id);
 if(!Number.isFinite(printTime)||printTime<0||printTime>=1e15||!old.length||old.length>128||emitters.length!==old.length||result.positions.length!==old.length||!queues.length||queues.length>old.length)throw new RangeError('Invalid stopped motion group');
 const oldIds=new Set(old.map(b=>b.id)),oldSteppers=new Set(old.map(b=>b.stepper)),oldQueues=new Set(old.map(b=>b.queue));
 if(oldIds.size!==old.length||oldSteppers.size!==old.length||old.some(b=>!validId(b.id)||!b.queue.ownsStepper(b.stepper)))throw new Error('Invalid retired motion binding');
 const endpoints=new Map(queues.map(q=>[q.id,q.position]));
 if(endpoints.size!==queues.length||queues.some(q=>!validId(q.id)||!Array.isArray(q.position)||q.position.length!==3||!q.position.every(Number.isFinite)))throw new RangeError('Invalid stopped queue endpoints');
 const observations=new Map(result.positions.map(p=>[`${p.member}:${p.oid}`,p]));
 if(observations.size!==result.positions.length||result.reasons.length<1||result.reasons.length>128||result.reasons.some(r=>r!==1&&r!==2&&r!==3))throw new Error('Invalid stopped position coverage');
 // Reject stale/disposed source handles before allocating replacements.
 for(const b of old)if(!Number.isFinite(b.stepper.generatedTime))throw new Error('Invalid retired generation state');
 const usedIds=new Set<string>(),usedQueues=new Set<string>(),usedPositions=new Set<string>();
 for(const e of emitters){
  const key=`${e.member}:${e.settings.oid}`,p=observations.get(key);
  if(!oldIds.has(e.id)||usedIds.has(e.id)||!endpoints.has(e.queueId)||!Number.isInteger(e.member)||e.member<0||e.member>=result.reasons.length||!Number.isInteger(e.settings.oid)||e.settings.oid<0||e.settings.oid>254||!p||usedPositions.has(key))throw new Error('Missing or duplicate stopped emitter');
  if(!Number.isInteger(p.raw)||p.raw< -0x80000000||p.raw>0x7fffffff||p.position!==BigInt(e.settings.invertDirection?-p.raw:p.raw)||typeof p.observedClock!=='bigint'||p.observedClock<0n||p.observedClock>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('Invalid stopped position observation');
  if(e.shapers!==undefined&&e.mode==='extruder'||e.pressureAdvance!==undefined&&e.mode!=='extruder')throw new Error('Filter does not match stopped emitter');
  usedIds.add(e.id);usedQueues.add(e.queueId);usedPositions.add(key);
 }
 if(usedQueues.size!==queues.length)throw new Error('Unused stopped queue');
 const prepared=new Map<string,TrapQueue>(),bindings:RebuiltBinding[]=[];
 const dispose=()=>{for(const b of bindings)b.stepper.dispose();for(const q of prepared.values())q.dispose();};
 try{
  for(const q of queues){const queue=new TrapQueue();prepared.set(q.id,queue);queue.setPosition(printTime,...q.position);}
  for(const e of emitters){
   const queue=prepared.get(e.queueId)!,p=observations.get(`${e.member}:${e.settings.oid}`)!;
   const position=new StepperPosition(e.rotationDistance,e.stepsPerRotation);
   // Firmware reset will use clock=0. Never inherit a stale compressor clock.
   const stepper=queue.createStepper({...e.settings,initialClock:0n},e.mode,position.state.stepDistance,endpoints.get(e.queueId)!);
   try{
    if(stepper.printTimeAtClock(p.observedClock)>printTime||stepper.clockAt(printTime)<p.observedClock)throw new RangeError('Rebuild precedes stopped observation');
    if(e.shapers)stepper.configureShapers(e.shapers);
    if(e.pressureAdvance)stepper.configurePressureAdvance(e.pressureAdvance.advance,e.pressureAdvance.smoothTime);
    position.align(p.position,stepper.commandedPosition);stepper.initializePosition(p.observedClock,p.position);
    if(stepper.generatedTime!==printTime)throw new Error('Inconsistent stopped generation baseline');
    bindings.push(Object.freeze({id:e.id,member:e.member,oid:e.settings.oid,inverted:!!e.settings.invertDirection,queue,stepper,position,history:new StepHistory(p.observedClock,p.position)}));
   }catch(error){stepper.dispose();throw error;}
  }
  for(const b of old)b.stepper.dispose();for(const q of oldQueues)q.dispose();
 }catch(error){dispose();throw error;}
 return Object.freeze({printTime,queues:Object.freeze(queues.map(q=>Object.freeze({id:q.id,queue:prepared.get(q.id)!,position:Object.freeze([...q.position])}))),bindings:Object.freeze(bindings),dispose,[Symbol.dispose]:dispose});
}
