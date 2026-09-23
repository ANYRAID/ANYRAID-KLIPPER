import type {LinearHomingPort,HomingPass} from './linear-command.ts';
import {LinearHomingSeek,type LinearSeekOptions} from './linear-seek.ts';
import {HomingRetractExecution} from './retract-execution.ts';
import {CoordinateRebase} from './recovery.ts';
import {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {createGuardedBedMeshPort} from '../motion/guarded-bed-mesh-port.ts';
import type {ExtrusionGuard} from '../motion/extrusion.ts';
import type {MotionLimits} from '../motion/lookahead.ts';
import type {Axis} from '../kinematics/linear.ts';
import {RebuiltMotionStreamer} from '../runtime/motion-streamer.ts';
import {serialClock} from '../protocol/serial-queue.ts';
export interface NativeLinearPortOptions extends Omit<LinearSeekOptions,'groups'> {
 groupsByAxis:readonly [LinearSeekOptions['groups'],LinearSeekOptions['groups'],LinearSeekOptions['groups']];
 limits:MotionLimits;extrusion:ExtrusionGuard;canExtrude:()=>boolean;
}
/** Native XYZE port for LinearHomingCommand. The runtime must provide configured
 * MCU/actuator ownership and a live thermal guard. Ordinary moves are admitted
 * to lookahead; flush paces a rolling prefix and drain waits for MCU time.
 * The runtime must arrange timely checkpoints and final drain. Mesh lifecycle
 * and product startup remain separate runtime responsibilities. */
export class NativeLinearHomingPort implements LinearHomingPort {
 #o:NativeLinearPortOptions;#g:NativeLinearPortOptions['generation'];#admission:ReturnType<typeof createGuardedBedMeshPort>;
 #streamer:RebuiltMotionStreamer;
 #busy=false;#fault:unknown;#failed=false;#abort=new AbortController();#stop:Promise<void>|undefined;#idle=Promise.resolve();#phase='idle';
 constructor(o:NativeLinearPortOptions){
  if(o.groupsByAxis.length!==3)throw new Error('Three homing axis configurations required');
  this.#o={...o,emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],limits:{...o.limits},groupsByAxis:o.groupsByAxis.map(groups=>groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))) as unknown as NativeLinearPortOptions['groupsByAxis']};
  this.#g=o.generation;this.#streamer=new RebuiltMotionStreamer(this.#g);this.#admission=this.#newAdmission(this.#g.source.status.position);this.assertActive();
 }
 #newAdmission(position:readonly number[]){return createGuardedBedMeshPort({mesh:null,physicalPosition:position,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});}
 get status(){return {busy:this.#busy,phase:this.#phase,failed:this.#failed,fault:this.#fault,pendingMoves:this.#admission.pending,stream:this.#streamer.status};}
 assertActive(){if(this.#failed)throw new Error('Native motion port stopped',{cause:this.#fault});this.#g.group.assertActive();}
 /** Last planned coordinates remain readable after stop; they are not measured position. */
 position(){return this.#admission.plannedPosition;}
 move(position:readonly number[],speed:number){this.assertActive();if(this.#busy)throw new Error('Native motion port busy');this.#admission.move(position,speed);}
 #check(signal:AbortSignal){signal.throwIfAborted();this.assertActive();}
 #futureTime(){const now=serialClock.now();return Math.max(...this.#g.members.map((m,i)=>this.#g.motion.bindings.find(b=>b.member===i)!.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))))+.2;}
 async #operate<T>(phase:string,signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  this.assertActive();if(this.#busy)throw new Error('Native motion port busy');this.#busy=true;this.#phase=phase;
  const idle=Promise.withResolvers<void>();this.#idle=idle.promise;const combined=AbortSignal.any([signal,this.#abort.signal]);
  const abort=()=>{void this.motorOff(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  try{this.#check(combined);const result=await work(combined);this.#check(combined);return result;}
  catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Native motion operation and stop failed');}throw error;}
  finally{combined.removeEventListener('abort',abort);this.#busy=false;this.#phase=this.#failed?'stopped':'idle';idle.resolve();}
 }
 async #drain(signal:AbortSignal){
  this.#check(signal);const moves=this.#admission.flush();
  const state=this.#g.source.status;if(!moves.length&&(state.paused||!state.seeded))return;
  await this.#streamer.append(moves,signal);this.#check(signal);
  await this.#g.source.drain([],signal);this.#check(signal);
 }
 /** Lazy lookahead commit, with MCU-time pacing but no forced stop boundary. */
 flush(signal:AbortSignal){return this.#operate('stream',signal,s=>this.#streamer.append(this.#admission.flush(true),s));}
 drain(signal:AbortSignal){return this.#operate('drain',signal,s=>this.#drain(s));}
 #adopt(next:NativeLinearPortOptions['generation'],position:readonly number[],signal:AbortSignal){
  this.#check(signal);const admission=this.#newAdmission(position);this.#admission.shutdown(new Error('Motion generation replaced'));this.#g=next;this.#streamer=new RebuiltMotionStreamer(next);this.#admission=admission;
 }
 forcePosition(position:readonly number[],signal:AbortSignal){
  const target=[...position];return this.#operate('rebase',signal,async s=>{
   await this.#drain(s);const g=this.#g,routes=g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}));
   let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
   try{
    if(target.length!==4||!target.every(Number.isFinite))throw new RangeError('Invalid forced XYZE position');
    motion=(await new CoordinateRebase({coordinator:g.coordinator,bindings:g.motion.bindings,members:g.members,emitters:this.#o.emitters,locate:()=>({queues:routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?target.slice(0,3):[target[r.extrusionAxis],0,0]) as [number,number,number]})),printTime:this.#futureTime()})}).recover(s)).motion;
    this.#check(s);const next=await bindRebuiltMotion({group:g.group,members:g.members,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position:target});this.#adopt(next,target,s);
   }catch(error){motion?.dispose();throw error;}
  });
 }
 home(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal):Promise<HomingPass>{
  const target=[...position];return this.#operate('seek',signal,async s=>{
   const result=await new LinearHomingSeek({...this.#o,generation:this.#g,groups:this.#o.groupsByAxis[axis]}).run(target,speed,axis,s);
   try{this.#adopt(result.generation,result.position,s);return result;}catch(error){result.motion.dispose();throw error;}
  });
 }
 retract(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal){
  const target=[...position];return this.#operate('retract',signal,async s=>{
   const halt=await new HomingRetractExecution(this.#g,this.#o.kinematics).run(target,speed,axis,s);this.#check(s);
   const admission=this.#newAdmission(halt);this.#admission.shutdown(new Error('Homing retreat completed'));this.#admission=admission;
  });
 }
 motorOff(cause:unknown):Promise<void>{
  if(this.#stop)return this.#stop;this.#failed=true;this.#fault=cause;this.#phase='stopped';this.#admission.shutdown(cause);this.#o.kinematics.clearHoming([0,1,2]);
  const stopped=Promise.withResolvers<void>();this.#stop=stopped.promise;this.#abort.abort(cause);
  void this.#g.drain.stop(cause).then(stopped.resolve,stopped.reject);return this.#stop;
 }
 async dispose(){try{await this.motorOff(new Error('Native motion port disposed'));await this.#idle;}finally{if(!this.#busy)this.#g.motion.dispose();}}
}
