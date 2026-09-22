import {LookAheadQueue} from '../motion/lookahead.ts';
import {LinearKinematics,type Axis} from '../kinematics/linear.ts';
import type {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
/** One retreat on a freshly recovered/bound generation. The owning G28 driver
 * must exclude all other producers, keep heaters/extrusion under their normal
 * guards, and retain this generation for the next coordinate rebase. */
export class HomingRetractExecution {
 #generation:Awaited<ReturnType<typeof bindRebuiltMotion>>;#kinematics:LinearKinematics;#started=false;
 constructor(generation:Awaited<ReturnType<typeof bindRebuiltMotion>>,kinematics:LinearKinematics){this.#generation=generation;this.#kinematics=kinematics;}
 async run(target:readonly number[],speed:number,axis:Axis,signal:AbortSignal,timeoutMs=30000):Promise<readonly number[]>{
  if(this.#started)throw new Error('Homing retract is single use');this.#started=true;
  const g=this.#generation;
  try{
   signal.throwIfAborted();g.assertFutureBaseline();
   const state=g.source.status,c=g.coordinator.status;
   if(state.retired||state.failed||state.busy||state.paused||state.bufferedMoves||state.sourceTime!==g.motion.printTime||c.busy||c.failed||c.retired||c.generatedTime!==g.motion.printTime)throw new Error('Homing retract requires an unused recovered generation');
   // The source drain checks all MCU health and waits for sampled clock passage.
   // Planning cannot use the ordinary unhomed-axis admission bypass elsewhere.
   const move=this.#kinematics.planHomingAxisMove(state.position,target,speed,axis),queue=new LookAheadQueue();queue.add(move);
   await g.source.drain(queue.flush(),signal,timeoutMs);signal.throwIfAborted();
   return Object.freeze([...g.source.status.position]);
  }catch(error){try{await g.drain.stop(error);}catch(stop){throw new AggregateError([error,stop],'Homing retract and stop failed');}throw error;}
 }
}
