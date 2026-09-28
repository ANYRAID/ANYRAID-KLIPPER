import {LookAheadQueue} from '../motion/lookahead.ts';
import type {Axis} from '../kinematics/linear.ts';
import type {HomingTrajectoryKinematics} from './trajectory-kinematics.ts';
import type {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {RebuiltMotionStreamer} from '../runtime/motion-streamer.ts';
/** One retreat on a freshly recovered/bound generation. The owning G28 driver
 * must exclude all other producers, keep heaters/extrusion under their normal
 * guards, and retain this generation for the next coordinate rebase. */
export class HomingRetractExecution {
 #generation:Awaited<ReturnType<typeof bindRebuiltMotion>>;#kinematics:HomingTrajectoryKinematics;#started=false;
 constructor(generation:Awaited<ReturnType<typeof bindRebuiltMotion>>,kinematics:HomingTrajectoryKinematics){this.#generation=generation;this.#kinematics=kinematics;}
 async run(target:readonly number[],speed:number,axis:Axis,signal:AbortSignal,timeoutMs=30000,mode:'home'|'probe'='home'):Promise<readonly number[]>{
  if(this.#started)throw new Error('Homing retract is single use');this.#started=true;
  const g=this.#generation;
  try{
   signal.throwIfAborted();g.assertFutureBaseline();
   if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new RangeError('Invalid retract timeout');
   const deadline=performance.now()+timeoutMs,remaining=()=>{signal.throwIfAborted();const ms=Math.ceil(deadline-performance.now());if(ms<=0)throw new Error('Homing retract timed out');return ms;};
   const state=g.source.status,c=g.coordinator.status;
   if(state.retired||state.failed||state.busy||state.paused||state.bufferedMoves||state.sourceTime!==g.motion.printTime||c.busy||c.failed||c.retired||c.generatedTime!==g.motion.printTime)throw new Error('Homing retract requires an unused recovered generation');
   // The source drain checks all MCU health and waits for sampled clock passage.
   // Planning cannot use the ordinary unhomed-axis admission bypass elsewhere.
   if(mode!=='home'&&mode!=='probe')throw new Error('Invalid retract mode');
   const move=mode==='probe'&&this.#kinematics.planProbeRetract?this.#kinematics.planProbeRetract(state.position,target,speed,axis):this.#kinematics.planHomingAxisMove(state.position,target,speed,axis),queue=new LookAheadQueue();queue.add(move);
   // Establish fresh motion lead and stationary filter coverage before the
   // retreat, just as ordinary motion does after a coordinate rebuild.
   await new RebuiltMotionStreamer(g).append(queue.flush(),signal,remaining());
   await g.source.drain([],signal,remaining());signal.throwIfAborted();
   return Object.freeze([...g.source.status.position]);
  }catch(error){try{await g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Homing retract and stop failed');}throw error;}
 }
}
