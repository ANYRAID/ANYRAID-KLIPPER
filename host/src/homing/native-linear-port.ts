import {StopNotice} from '../runtime/stop-notice.ts';
import type {LinearHomingPort,HomingPass} from './linear-command.ts';
import {LinearHomingSeek,type LinearSeekOptions} from './linear-seek.ts';
import {HomingRetractExecution} from './retract-execution.ts';
import {CoordinateRebase} from './recovery.ts';
import {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {createGuardedBedMeshPort,createMotionValidator} from '../motion/guarded-bed-mesh-port.ts';
import type {ExtrusionGuard} from '../motion/extrusion.ts';
import type {MotionLimits} from '../motion/lookahead.ts';
import type {Axis} from '../kinematics/linear.ts';
import {RebuiltMotionStreamer,type StreamPause} from '../runtime/motion-streamer.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {recoveryEmitters} from './recovery-emitters.ts';
export interface NativeLinearPortOptions extends Omit<LinearSeekOptions,'groups'> {
 groupsByAxis:readonly [LinearSeekOptions['groups'],LinearSeekOptions['groups'],LinearSeekOptions['groups']];
 limits:MotionLimits;extrusion:ExtrusionGuard;canExtrude:()=>boolean;
}
export interface PausedMove {position:readonly number[];speed:number;}
/** Native XYZE port for LinearHomingCommand. The runtime must provide configured
 * MCU/actuator ownership and a live thermal guard. Ordinary moves are admitted
 * to lookahead; flush paces a rolling prefix and drain waits for MCU time.
 * The runtime must arrange timely checkpoints and final drain. Mesh lifecycle
 * and product startup remain separate runtime responsibilities. */
export class NativeLinearHomingPort implements LinearHomingPort {
 #o:NativeLinearPortOptions;#g:NativeLinearPortOptions['generation'];#admission:ReturnType<typeof createGuardedBedMeshPort>;
 #streamer:RebuiltMotionStreamer;
 #pause:Promise<StreamPause>|undefined;#pauseReady=false;#resuming=false;
 #pauseMode:'held'|'owned'|'stationary'|undefined;#ownedPauseRun:Promise<void>|undefined;
 #pausePosition:readonly number[]|undefined;#pausedBusy=false;#pausedIdle=Promise.resolve();
 #notice=new StopNotice();#unsubscribeGroup:(()=>void)|undefined;
 #disposal:Promise<void>|undefined;
 #busy=false;#fault:unknown;#failed=false;#abort=new AbortController();#stop:Promise<void>|undefined;#idle=Promise.resolve();#phase='idle';
 constructor(o:NativeLinearPortOptions){
  if(o.groupsByAxis.length!==3)throw new Error('Three homing axis configurations required');
  this.#o={...o,emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],limits:{...o.limits},groupsByAxis:o.groupsByAxis.map(groups=>groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))) as unknown as NativeLinearPortOptions['groupsByAxis']};
  this.#g=o.generation;this.#streamer=new RebuiltMotionStreamer(this.#g);this.#admission=this.#newAdmission(this.#g.source.status.position);this.assertActive();this.#watchGroup();
 }
 subscribeStop(listener:(cause:unknown)=>void):()=>void{return this.#notice.subscribe(listener);}
 usesKinematics(kinematics:NativeLinearPortOptions['kinematics']):boolean{return this.#o.kinematics===kinematics;}
 #watchGroup(){this.#unsubscribeGroup?.();this.#unsubscribeGroup=this.#g.group.subscribeStop(cause=>{void this.motorOff(cause).catch(()=>{});});}
 #newAdmission(position:readonly number[]){return createGuardedBedMeshPort({mesh:null,physicalPosition:position,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});}
 get status(){return {busy:this.#busy,phase:this.#phase,failed:this.#failed,fault:this.#fault,observerErrors:this.#notice.errors,pendingMoves:this.#admission.pending,stream:this.#streamer.status,pauseMode:this.#pauseMode,pausedMotion:this.#pausedBusy,pausePosition:this.#pausePosition?[...this.#pausePosition]:undefined};}
 assertActive(){if(this.#failed)throw new Error('Native motion port stopped',{cause:this.#fault});this.#g.group.assertActive();}
 /** Last planned coordinates remain readable after stop; they are not measured position. */
 position(){return this.#admission.plannedPosition;}
 move(position:readonly number[],speed:number){this.assertActive();if(this.#pause||this.#resuming||this.#busy&&!this.#ownedPauseRun)throw new Error('Native motion port busy or paused');this.#admission.move(position,speed);}
 markPendingBoundary(id:number):boolean{this.assertActive();if(this.#pause||this.#resuming||this.#busy&&!this.#ownedPauseRun)throw new Error('Native motion port busy or paused');return this.#admission.markPendingBoundary(id);}
 get hasCoolingFan():boolean{return this.#g.boundaryOutput!==undefined;}
 get hasMotorEnable():boolean{return this.#g.motorEnable!==undefined;}
 get canReleaseMotors():boolean{return this.#g.motorEnable?.canReleaseAll??false;}
 releaseMotors(signal:AbortSignal):Promise<void>{if(this.#g.motorEnable&&!this.canReleaseMotors)return Promise.reject(new Error('Always-on motors cannot be released by software'));return this.#operate('release',signal,async s=>{
  const power=this.#g.motorEnable;if(!power)throw new Error('Motor enables are not configured');
  await this.#drain(s);this.#g.assertMotorCalibration();this.#o.kinematics.clearHoming([0,1,2]);
  await power.disableAll(this.#g.source.status.sourceTime,s);this.#check(s);
 });}
 queueCoolingFan(value:number,signal:AbortSignal):Promise<void>{return this.#operate('output',signal,async()=>{
  const output=this.#g.boundaryOutput;if(!output)throw new Error('Cooling fan is not configured');
  const id=output.register(value);if(!this.#admission.markPendingBoundary(id))this.#g.source.markBoundary(id);
 });}
 #check(signal:AbortSignal){signal.throwIfAborted();this.assertActive();}
 #futureTime(){const now=serialClock.now();return Math.max(...this.#g.clockMembers.map(m=>m.stepper.printTimeAtClock(m.session.clock.sync.getClock(now))))+.2;}
 async #operate<T>(phase:string,signal:AbortSignal,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  this.assertActive();if(this.#pause)throw new Error('Native motion port busy or paused');
  if(this.#ownedPauseRun){
   const prior=this.#ownedPauseRun,abort=()=>{void this.motorOff(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   try{await prior;signal.throwIfAborted();this.assertActive();}finally{signal.removeEventListener('abort',abort);}
  }
  if(this.#busy||this.#pause)throw new Error('Native motion port busy or paused');this.#busy=true;this.#phase=phase;
  const idle=Promise.withResolvers<void>();this.#idle=idle.promise;const combined=AbortSignal.any([signal,this.#abort.signal]);
  const abort=()=>{void this.motorOff(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  try{this.#check(combined);const result=await work(combined);this.#check(combined);return result;}
  catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Native motion operation and stop failed');}throw error;}
  finally{combined.removeEventListener('abort',abort);this.#ownedPauseRun=undefined;this.#busy=false;this.#phase=this.#failed?'stopped':'idle';idle.resolve();}
 }
 async #drain(signal:AbortSignal){
  this.#check(signal);const moves=this.#admission.flush();
  const state=this.#g.source.status;if(!moves.length&&(state.paused||!state.seeded)){
   if(!state.pendingBoundaries)return;await this.#prepareIdleBoundary(signal);
   // This interval is known stationary. Do not run an empty rolling stream:
   // its filter-tail stop condition is intended for actual motion coverage.
   await this.#g.source.drain([],signal);this.#check(signal);return;
  }
  await this.#streamer.append(moves,signal);this.#check(signal);
  await this.#g.source.drain([],signal);this.#check(signal);
 }
 async #prepareIdleBoundary(signal:AbortSignal,calibrationReserve=0){
  const source=this.#g.source,state=source.status,padding=Math.max(.001,...this.#g.motion.bindings.flatMap(b=>[b.stepper.scanWindow.future,b.stepper.scanWindow.past]));
  const time=Math.max(state.sourceTime+padding+.001+calibrationReserve,this.#futureTime()+padding+calibrationReserve);if(state.paused)source.resumeAt(time);else source.startAt(time);
  await source.prepareIdle(signal,30000,calibrationReserve);this.#check(signal);
 }
 /** Exclusive stationary checkpoint for the product scheduler. No implicit
  * flushing of pending user motion or output, and no homing permission gain. */
 maintainIdleClocks(signal:AbortSignal):Promise<{attempted:number;updated:number}>{
  this.#check(signal);const state=this.#g.source.status;
  if(this.#admission.pending||state.pendingBoundaries||state.seeded&&!state.paused)throw new Error('Idle clock maintenance requires stationary ownership');
  return this.#operate('clock',signal,async s=>{
   if(!this.#g.clockTimelines?.some(c=>c.synchronizer))return {attempted:0,updated:0};
   await this.#prepareIdleBoundary(s,.01);
   const future=Math.max(...this.#g.motion.bindings.map(b=>b.stepper.scanWindow.future));
   const result=this.#g.maintainClocks(this.#g.source.status.sourceTime-future-.001);
   await this.#g.source.drain([],s);this.#check(s);return result;
  });
 }
 get idleClockMaintenanceDue():boolean{
  if(this.#failed||this.#busy||this.#pause||this.#resuming||this.#pausedBusy||this.#admission.pending)return false;
  const state=this.#g.source.status;
  return !state.busy&&!state.pendingBoundaries&&(!state.seeded||state.paused)&&this.#g.clockMaintenanceDue();
 }
 /** Lazy lookahead commit, with MCU-time pacing but no forced stop boundary. */
 flush(signal:AbortSignal){return this.#operate('stream',signal,async s=>{const state=this.#g.source.status;if(!this.#admission.pending&&state.pendingBoundaries&&(state.paused||!state.seeded)){await this.#drain(s);return;}await this.#streamer.append(this.#admission.flush(true),s);});}
 drain(signal:AbortSignal){return this.#operate('drain',signal,s=>this.#drain(s));}
 /** A confirmed paused stop already crossed the MCU boundary. Heating may be
  * adjusted there without resuming the retained trajectory or parking moves. */
 async heaterBoundary(signal:AbortSignal):Promise<void>{
  this.#check(signal);
  if(!this.#pause){await this.drain(signal);return;}
  if(!this.#pauseReady||this.#resuming||this.#pausedBusy||!this.#g.source.status.paused||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused')throw new Error('Native heater boundary is not stationary');
 }

 /** Product pause after file admission is fenced. A boundary-owned stream
  * remains internal; later checkpoints await its suffix before taking over. */
 pause(signal:AbortSignal):Promise<StreamPause>{
  try{
   this.#check(signal);if(this.#resuming)throw new Error('Native motion stream is resuming');if(this.#pause)return this.#pause;
   if(this.#busy)return this.pauseStream(signal);
   const state=this.#g.source.status;
   if(this.#admission.pending||state.seeded&&!state.paused){
    const running=this.#operate('stream',this.#abort.signal,s=>this.#streamer.append(this.#admission.flush(),s));void running.catch(()=>{});
    const paused=this.pauseStream(signal);if(this.#pause){this.#pauseMode='owned';this.#ownedPauseRun=running;}return paused;
   }
   this.#pauseMode='stationary';
   const paused=this.#operate('pause',signal,async s=>{
    if(!this.#g.source.status.paused||this.#g.source.status.pendingBoundaries){
     await this.#prepareIdleBoundary(s);await this.#g.source.drain([],s);
    }
    this.#check(s);const current=this.#g.source.status,stopped=Object.freeze({position:Object.freeze([...current.position]),sourceTime:current.sourceTime});
    this.#pausePosition=stopped.position;this.#pauseReady=true;return stopped;
   });this.#pause=paused;void paused.catch(()=>{});return paused;
  }catch(error){return Promise.reject(error);}
 }
 /** Interrupt an active rolling flush/drain without releasing its exclusive
  * ownership. The result is a drained planned stop, not measured coordinates.
  * The caller must fence further file admission before requesting this pause. */
 pauseStream(signal:AbortSignal):Promise<StreamPause>{
  try{
   this.#check(signal);if(this.#resuming)throw new Error('Native motion stream is resuming');if(this.#pause)return this.#pause;
   if(!this.#busy||!['stream','drain'].includes(this.#phase)||!this.#streamer.status.busy)throw new Error('No active native stream to pause');
   const done=Promise.withResolvers<StreamPause>();this.#pause=done.promise;this.#pauseMode='held';void done.promise.catch(()=>{});
   const abort=()=>{void this.motorOff(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
   void (async()=>{
    try{
     // Transfer only once; this closes a lazy prefix at rest. The original
     // admission endpoint remains the end of the retained print trajectory.
     const stopped=await this.#streamer.requestPause(this.#admission.flush());this.#check(signal);this.#pausePosition=stopped.position;this.#pauseReady=true;done.resolve(stopped);
    }catch(error){try{await this.motorOff(error);}catch(stop){error=new AggregateError([error,stop],'Native pause and stop failed');}done.reject(error);}
    finally{signal.removeEventListener('abort',abort);}
   })();return done.promise;
  }catch(error){return Promise.reject(error);}
 }
 /** Exclusive auxiliary travel after pause confirmation. Does not alter the
  * retained print endpoint or G-code modal coordinates. Each leg is guarded,
  * paced and drained; the product owner supplies the safe parking/return path. */
 validatePausedPath(legs:readonly PausedMove[]):void{
  this.assertActive();if(!this.#pauseReady||this.#resuming||this.#pausedBusy||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused'||!this.#g.source.status.paused)throw new Error('Native stream is not available for paused motion');
  if(!Array.isArray(legs)||legs.length>64)throw new RangeError('Invalid paused motion path');
  const admission=this.#newAdmission(this.#g.source.status.position);
  for(const leg of legs){admission.move(leg.position,leg.speed);admission.flush();}
 }
 async movePaused(position:readonly number[],speed:number,signal:AbortSignal):Promise<void>{
  this.#check(signal);if(!this.#pauseReady||this.#resuming||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused')throw new Error('Native stream is not paused');
  if(this.#pausedBusy)throw new Error('Paused motion is busy');
  const target=[...position];this.#pausedBusy=true;const idle=Promise.withResolvers<void>();this.#pausedIdle=idle.promise;
  const combined=AbortSignal.any([signal,this.#abort.signal]),abort=()=>{void this.motorOff(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  try{
   this.#check(combined);if(!this.#g.source.status.paused)throw new Error('Paused source is not drained');
   const admission=this.#newAdmission(this.#g.source.status.position);admission.move(target,speed);const moves=admission.flush();
   if(moves.length){await new RebuiltMotionStreamer(this.#g).append(moves,combined);this.#check(combined);await this.#g.source.drain([],combined);}
   this.#check(combined);
  }catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Paused motion and stop failed');}throw error;}
  finally{combined.removeEventListener('abort',abort);this.#pausedBusy=false;idle.resolve();}
 }
 /** Resolves after live guards and fresh motion lead are established, before
  * the held flush/drain completes its retained trajectory. */
 async resumeStream(signal:AbortSignal):Promise<void>{
  this.#check(signal);if(!this.#pauseReady||this.#resuming)throw new Error('Native stream is not paused');
  if(this.#pausedBusy)throw new Error('Paused motion is busy');
  const current=this.#g.source.status;if(!current.paused||!this.#pausePosition||current.position.length!==this.#pausePosition.length||current.position.some((v,i)=>v!==this.#pausePosition![i]))throw new Error('Must return to the drained pause position before resuming');
  this.#resuming=true;
  const abort=()=>{void this.motorOff(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
  try{if(this.#pauseMode!=='stationary')await this.#streamer.resume(createMotionValidator(this.#o));this.#check(signal);this.#pause=undefined;this.#pauseReady=false;this.#pausePosition=undefined;this.#pauseMode=undefined;}
  catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Native resume and stop failed');}throw error;}
  finally{this.#resuming=false;signal.removeEventListener('abort',abort);}
 }
 #adopt(next:NativeLinearPortOptions['generation'],position:readonly number[],signal:AbortSignal){
  this.#check(signal);const admission=this.#newAdmission(position);this.#admission.shutdown(new Error('Motion generation replaced'));this.#g=next;this.#streamer=new RebuiltMotionStreamer(next);this.#admission=admission;this.#watchGroup();
 }
 forcePosition(position:readonly number[],signal:AbortSignal){
  const target=[...position];return this.#operate('rebase',signal,async s=>{
   await this.#drain(s);const g=this.#g,routes=g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}));
   let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
   try{
    if(target.length!==4||!target.every(Number.isFinite))throw new RangeError('Invalid forced XYZE position');
    const emitters=recoveryEmitters(g.motion.bindings,this.#o.emitters),boundaryTransfer=g.releaseBoundaryOutput();
    motion=(await new CoordinateRebase({coordinator:g.coordinator,bindings:g.motion.bindings,members:g.members,emitters,locate:()=>({queues:routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?target.slice(0,3):[target[r.extrusionAxis],0,0]) as [number,number,number]})),printTime:this.#futureTime()})}).recover(s)).motion;
    this.#check(s);const next=await bindRebuiltMotion({group:g.group,clockTimelines:g.clockTimelines,members:g.members,auxiliaryMCUs:g.auxiliaryMCUs,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position:target,boundaryTransfer,motorEnable:g.motorEnable});this.#adopt(next,target,s);
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
  void this.#g.drain.stop(cause).then(stopped.resolve,stopped.reject);this.#notice.emit(cause);return this.#stop;
 }
 /** Stop failure must not bypass in-flight owners or leak their final generation.
  * Publish before motorOff: group observers can re-enter shutdown synchronously. */
 dispose():Promise<void>{
  if(this.#disposal)return this.#disposal;
  const done=Promise.withResolvers<void>();this.#disposal=done.promise;
  void (async()=>{
   const errors:unknown[]=[];
   try{await this.motorOff(new Error('Native motion port disposed'));}catch(error){errors.push(error);}
   // Both operations settle their idle promises in finally, even on stop error.
   await Promise.all([this.#idle,this.#pausedIdle]);
   try{this.#unsubscribeGroup?.();this.#g.motion.dispose();}catch(error){errors.push(error);}
   if(errors.length===1)throw errors[0];
   if(errors.length)throw new AggregateError(errors,'Native motion disposal failed');
  })().then(done.resolve,done.reject);
  return done.promise;
 }
}
