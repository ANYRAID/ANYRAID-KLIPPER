import type {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import type {Axis} from '../kinematics/linear.ts';
import type {HomingTrajectoryKinematics} from './trajectory-kinematics.ts';
import {LookAheadQueue} from '../motion/lookahead.ts';
import {stationaryRows} from '../motion/stationary.ts';
/** Transfer an unused recovered generation to HomingMoveExecution's exclusive
 * drip producer. Success prepares native source data and history coverage only;
 * no step generation, trigger arming or homing authority is issued here. */
export async function prepareHomingTrajectory(g:Awaited<ReturnType<typeof bindRebuiltMotion>>,kinematics:HomingTrajectoryKinematics,target:readonly number[],speed:number,axis:Axis,signal:AbortSignal,mode:'home'|'probe'='home'){
 try{
  signal.throwIfAborted();g.assertFutureBaseline();const state=g.source.status,c=g.coordinator.status,startTime=g.motion.printTime;
  if(state.retired||state.failed||state.busy||state.paused||state.bufferedMoves||state.sourceTime!==startTime||c.busy||c.failed||c.retired||c.generatedTime!==startTime||c.committedTime!==startTime)throw new Error('Homing preparation requires an unused recovered generation');
  if(mode!=='home'&&mode!=='probe')throw new Error('Invalid trajectory mode');
  const move=mode==='probe'&&kinematics.planProbeAxisMove?kinematics.planProbeAxisMove(state.position,target,speed,axis):kinematics.planHomingAxisMove(state.position,target,speed,axis),lookahead=new LookAheadQueue();lookahead.add(move);const moves=lookahead.flush();
  let future=0,delay=.001;for(const b of g.motion.bindings){const w=b.stepper.scanWindow;future=Math.max(future,w.future);delay=Math.max(delay,w.future,w.past);}
  // Original homing.py's 1ms dwell plus toolhead.drip_move's kin_flush_delay.
  // Delay the actual source so shaping cannot emit before endstop sampling.
  const movementStart=(startTime+.001)+delay,p=move.profile!;
  const nominalEnd=((movementStart+p.accelT)+p.cruiseT)+p.decelT,endTime=nominalEnd+delay,sourceUntil=endTime+future+.001;
  if(![movementStart,nominalEnd,endTime,sourceUntil].every(Number.isFinite)||!(movementStart>startTime&&nominalEnd>movementStart&&endTime>nominalEnd&&sourceUntil>endTime)||sourceUntil>=1e12||movementStart-startTime<future||sourceUntil-endTime<future)throw new RangeError('Unrepresentable homing source horizon');
  // Use the routes already validated by bindRebuiltMotion, never guess an
  // extrusion queue from its id or a solver's actuator direction.
  const routes=g.routes;
  if(!routes.length)throw new Error('Missing homing source routes');
  const histories=g.motion.bindings.map(b=>({binding:b,clock:b.stepper.clockAt(startTime)}));
  for(const {binding:b,clock} of histories)if(b.history.status.throughClock>clock)throw new Error('Homing history already advanced');
  g.source.retireProducer();
  for(const r of routes){
   const start=r.extrusionAxis===undefined?state.position.slice(0,3):[state.position[r.extrusionAxis],0,0],end=r.extrusionAxis===undefined?move.endPos.slice(0,3):[move.endPos[r.extrusionAxis],0,0];
   r.queue.appendRaw(stationaryRows(startTime,movementStart,start));
   if(r.queue.appendPlanned(moves,movementStart,r.extrusionAxis,true)!==nominalEnd)throw new Error('Homing source timelines differ');
   r.queue.appendRaw(stationaryRows(nominalEnd,sourceUntil,end));
  }
  // Recovery's known constant position covers the initial stationary baseline.
  // The native initialization marker remains queued and is archived on flush.
  for(const {binding:b,clock} of histories)b.history.append({history:new BigInt64Array(),position:b.history.status.lastPlannedPosition},clock);
  const prepareWindow=g.handoffHomingClocks(endTime,sourceUntil);
  return Object.freeze({startTime,movementStart,nominalEnd,endTime,sourceUntil,startPosition:Object.freeze([...state.position]),endPosition:Object.freeze([...move.endPos]),speed,prepareWindow});
 }catch(error){try{await g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Homing preparation and stop failed');}throw error;}
}
