import {collectProbeSamples,type ProbeSamples} from './probe-samples.ts';
import {nativeBedMeshStatus} from '../runtime/native-bed-mesh-status.ts';
import {BedMesh} from '../motion/bed-mesh.ts';
import type {BedMeshFadeConfig} from '../motion/bed-mesh-fade.ts';
import {StopNotice} from '../runtime/stop-notice.ts';
import {dwellMove} from '../motion/dwell.ts';
import type {LinearHomingPort,HomingPass} from './linear-command.ts';
import {LinearHomingSeek,type LinearSeekOptions} from './linear-seek.ts';
import {HomingRetractExecution} from './retract-execution.ts';
import {CoordinateRebase} from './recovery.ts';
import {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {createGuardedBedMeshPort,createMotionValidator} from '../motion/guarded-bed-mesh-port.ts';
import type {ExtrusionGuard} from '../motion/extrusion.ts';
import type {MotionLimits} from '../motion/lookahead.ts';
import {VelocityLimits,VelocityUpdateUnavailable,type VelocitySettings,type VelocityUpdate} from '../motion/velocity-limits.ts';
import type {Axis} from '../kinematics/linear.ts';
import {RebuiltMotionStreamer,type StreamPause} from '../runtime/motion-streamer.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {recoveryEmitters} from './recovery-emitters.ts';
import {copyPressureWindowChanges,pressureAdvanceSettings,planPressureAdvance,type PressureWindowChange,type PressureAdvanceSettings} from '../motion/pressure-advance-settings.ts';
export interface NativeLinearPortOptions extends Omit<LinearSeekOptions,'groups'|'mode'> {
 probeGroups?:LinearSeekOptions['groups'];
 groupsByAxis:readonly [LinearSeekOptions['groups'],LinearSeekOptions['groups'],LinearSeekOptions['groups']];
 limits:MotionLimits;extrusion:ExtrusionGuard;canExtrude:()=>boolean;
 velocitySettings?:Pick<VelocitySettings,'squareCornerVelocity'|'minCruiseRatio'>;
}
export interface PausedMove {position:readonly number[];speed:number;}
/** Native XYZE port for LinearHomingCommand. The runtime must provide configured
 * MCU/actuator ownership and a live thermal guard. Ordinary moves are admitted
 * to lookahead; flush paces a rolling prefix and drain waits for MCU time.
 * The runtime must arrange timely checkpoints and final drain. Mesh lifecycle
 * and product startup remain separate runtime responsibilities. */
export class NativeLinearHomingPort implements LinearHomingPort {
 #o:NativeLinearPortOptions;#g:NativeLinearPortOptions['generation'];#admission:ReturnType<typeof createGuardedBedMeshPort>;
 #meshStatus=nativeBedMeshStatus(null,'');
 get bedMeshStatus(){return this.#meshStatus;}
 #mesh:BedMesh|null=null;#meshSettings:{fadeConfig?:BedMeshFadeConfig;splitDeltaZ?:number;checkDistance?:number}={};
 #streamer:RebuiltMotionStreamer;
 #velocity:VelocityLimits;
 #pressure=new Map<string,Readonly<PressureAdvanceSettings>>();
 #pause:Promise<StreamPause>|undefined;#pauseReady=false;#resuming=false;
 #pauseMode:'held'|'owned'|'stationary'|undefined;#ownedPauseRun:Promise<void>|undefined;
 #pausePosition:readonly number[]|undefined;#pausedBusy=false;#pausedIdle=Promise.resolve();
 #pausedClock:Promise<{attempted:number;updated:number}>|undefined;
 #notice=new StopNotice();#unsubscribeGroup:(()=>void)|undefined;
 #disposal:Promise<void>|undefined;
 #busy=false;#fault:unknown;#failed=false;#abort=new AbortController();#stop:Promise<void>|undefined;#idle=Promise.resolve();#phase='idle';
 constructor(o:NativeLinearPortOptions){
  if(o.groupsByAxis.length!==3)throw new Error('Three homing axis configurations required');
  this.#velocity=new VelocityLimits(o.limits,o.velocitySettings);
  this.#o={...o,probeGroups:o.probeGroups?.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))})),emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],limits:{...o.limits},groupsByAxis:o.groupsByAxis.map(groups=>groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))) as unknown as NativeLinearPortOptions['groupsByAxis']};
  this.#g=o.generation;this.#streamer=new RebuiltMotionStreamer(this.#g);this.#admission=this.#newAdmission(this.#g.source.status.position);this.assertActive();this.#watchGroup();
  for(const b of this.#g.motion.bindings){const p=b.stepper.recoveryFilters().pressureAdvance;if(p)this.#pressure.set(b.id,pressureAdvanceSettings(p.advance,p.smoothTime));}
 }
 subscribeStop(listener:(cause:unknown)=>void):()=>void{return this.#notice.subscribe(listener);}
 usesKinematics(kinematics:NativeLinearPortOptions['kinematics']):boolean{return this.#o.kinematics===kinematics;}
 #watchGroup(){this.#unsubscribeGroup?.();this.#unsubscribeGroup=this.#g.group.subscribeStop(cause=>{void this.motorOff(cause).catch(()=>{});});}
 #newAdmission(position:readonly number[],physical=false){return createGuardedBedMeshPort({mesh:physical?null:this.#mesh,...this.#meshSettings,physicalPosition:position,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});}
 get status(){return {busy:this.#busy,phase:this.#phase,failed:this.#failed,fault:this.#fault,observerErrors:this.#notice.errors,pendingMoves:this.#admission.pending,stream:this.#streamer.status,pauseMode:this.#pauseMode,pausedMotion:this.#pausedBusy,pausedClockMaintenance:this.#pausedClock!==undefined,pausePosition:this.#pausePosition?[...this.#pausePosition]:undefined};}
 assertActive(){if(this.#failed)throw new Error('Native motion port stopped',{cause:this.#fault});this.#g.group.assertActive();}
 /** Last planned coordinates remain readable after stop; they are not measured position. */
 position(){return this.#admission.logicalPosition;}
 homingPosition(){return this.#admission.plannedPosition;}
 currentBedMesh(){return this.#mesh?.copy()??null;}
 async offsetBedMesh(x:number|null,y:number|null,toolOffset:number|null,signal:AbortSignal):Promise<boolean>{
  this.assertActive();signal.throwIfAborted();
  if([x,y,toolOffset].some(v=>v!==null&&!Number.isFinite(v)))throw new RangeError('Invalid mesh offset');
  const mesh=this.currentBedMesh();if(!mesh)return false;
  mesh.setOffsets(x,y);const settings=structuredClone(this.#meshSettings);
  if(toolOffset!==null)settings.fadeConfig={...settings.fadeConfig,toolOffset};
  await this.replaceBedMesh(mesh,settings,signal,String(this.#meshStatus.profile_name));return true;
 }
 replaceBedMesh(mesh:BedMesh|null,settings:{fadeConfig?:BedMeshFadeConfig;splitDeltaZ?:number;checkDistance?:number},signal:AbortSignal,profileName=''):Promise<void>{
  if(typeof profileName!=='string'||profileName.length>128||/[\x00-\x1f\x7f]/.test(profileName))return Promise.reject(new RangeError('Invalid mesh profile name'));
  const owned=mesh?.copy()??null,options=structuredClone(settings),status=nativeBedMeshStatus(owned,profileName);
  return this.#operate('mesh',signal,async s=>{
   const next=createGuardedBedMeshPort({mesh:owned,...options,physicalPosition:this.#admission.plannedPosition,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});
   await this.#drain(s);this.#check(s);this.#admission.shutdown(new Error('Mesh generation replaced'));this.#mesh=owned;this.#meshSettings=options;this.#admission=next;this.#meshStatus=status;
  });
 }
 move(position:readonly number[],speed:number){this.assertActive();if(this.#pause||this.#resuming||this.#busy&&!this.#ownedPauseRun)throw new Error('Native motion port busy or paused');this.#admission.move(position,speed);}
 get velocitySettings(){return this.#velocity.state;}
 get velocityStatus(){return this.#velocity.objectStatus;}
 /** Accepted configuration, not the coefficient currently executing on MCU. */
 pressureAdvanceSettings(id:string):Readonly<PressureAdvanceSettings>{const state=this.#pressure.get(id);if(!state)throw new RangeError('Unknown pressure advance emitter');return state;}
 /** Serialize requested settings with the path owner. Same-window updates
  * attach to the latest endpoint without flushing lookahead or stopping motion. */
 setPressureAdvance(id:string,next:PressureAdvanceSettings,signal:AbortSignal):Promise<void>{
  this.pressureAdvanceSettings(id);const owned=pressureAdvanceSettings(next.advance,next.smoothTime);
  if(this.#pause)return this.#setPausedPressure(id,owned,signal);
  return this.#operate('pressure',signal,async s=>{
   const change=planPressureAdvance(this.pressureAdvanceSettings(id),owned);
   if(change.kind==='window-change'){await this.#applyPressureWindows([{stepper:id,...owned}],s);return;}
   if(change.nextWindow>0&&change.previous.advance!==owned.advance){
    const boundary={stepper:id,advance:owned.advance};
    if(!this.#admission.markPendingPressureBoundary(boundary))this.#g.source.markPressureBoundary(boundary);
   }
   // An effective zero window has no compensation to schedule. Retain the
   // requested settings here; a later enable still crosses a native barrier.
   this.#check(s);this.#pressure.set(id,owned);
  });
 }
 async #setPausedPressure(id:string,owned:Readonly<PressureAdvanceSettings>,signal:AbortSignal):Promise<void>{
  this.#check(signal);
  if(!this.#pauseReady||this.#resuming||this.#pausedBusy||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused')throw new Error('Native pressure boundary is not paused or is busy');
  this.#pausedBusy=true;const idle=Promise.withResolvers<void>();this.#pausedIdle=idle.promise;
  const combined=AbortSignal.any([signal,this.#abort.signal]),abort=()=>{void this.motorOff(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  try{
   if(this.#pausedClock)await this.#awaitPausedClock(combined);this.#check(combined);
   await this.#streamer.reconfigurePausedPressureWindows([{stepper:id,...owned}],combined);this.#check(combined);this.#pressure.set(id,owned);
  }catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Paused pressure operation and stop failed');}throw error;}
  finally{combined.removeEventListener('abort',abort);this.#pausedBusy=false;idle.resolve();}
 }
 /** Window changes close lookahead to rest. Fixed-window coefficient updates
  * require geometric endpoint admission and must not use this slower path. */
 reconfigurePressureWindows(changes:readonly PressureWindowChange[],signal:AbortSignal):Promise<void>{
  const owned=copyPressureWindowChanges(changes);
  for(const c of owned)if(planPressureAdvance(this.pressureAdvanceSettings(c.stepper),c).kind!=='window-change')throw new RangeError('Pressure coefficient update requires endpoint admission');
  return this.#operate('pressure-window',signal,s=>this.#applyPressureWindows(owned,s));
 }
 async #applyPressureWindows(owned:readonly PressureWindowChange[],s:AbortSignal):Promise<void>{
   const moves=this.#admission.flush();
   if(moves.length)await this.#streamer.append(moves,s);
   else{const state=this.#g.source.status;if(state.paused||!state.seeded)await this.#prepareIdleBoundary(s);}
   this.#check(s);await this.#streamer.reconfigurePressureWindows(owned,s);this.#check(s);
   for(const c of owned)this.#pressure.set(c.stepper,pressureAdvanceSettings(c.advance,c.smoothTime));
 }
 updateVelocityLimits(patch:VelocityUpdate):void {
  this.assertActive();if(this.#pause||this.#resuming||this.#busy)throw new VelocityUpdateUnavailable();
  this.#velocity.update(patch,limits=>{this.#admission.setMotionLimits(limits);this.#o.kinematics.setMotionLimits(limits.maxVelocity,limits.maxAccel);this.#o.limits=limits;});
 }
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
  return this.#operate('clock',signal,s=>this.#maintainStationaryClocks(s));
 }
 async #maintainStationaryClocks(s:AbortSignal){
   if(!this.#g.clockTimelines?.some(c=>c.synchronizer))return {attempted:0,updated:0};
   await this.#prepareIdleBoundary(s,.01);
   const future=Math.max(...this.#g.motion.bindings.map(b=>b.stepper.scanWindow.future));
   const result=this.#g.maintainClocks(this.#g.source.status.sourceTime-future-.001);
   await this.#g.source.drain([],s);this.#check(s);return result;
 }
 get pausedClockMaintenanceDue():boolean{
  return !this.#failed&&this.#pauseReady&&!this.#resuming&&!this.#pausedBusy&&!this.#pausedClock&&(this.#pauseMode==='stationary'||this.#streamer.status.pause==='paused')&&this.#g.source.status.paused&&this.#g.clockMaintenanceDue();
 }
 /** The held stream remains parked. Parking/resume owners join this barrier
  * before touching the source; modal coordinates and retained moves stay put. */
 maintainPausedClocks(signal:AbortSignal):Promise<{attempted:number;updated:number}>{
  this.#check(signal);
  if(!this.#pauseReady||this.#resuming||this.#pausedBusy||this.#pausedClock||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused'||!this.#g.source.status.paused)throw new Error('Paused clock maintenance requires stationary ownership');
  const done=Promise.withResolvers<{attempted:number;updated:number}>();this.#pausedClock=done.promise;void done.promise.catch(()=>{});
  const local=AbortSignal.any([signal,this.#abort.signal]),abort=()=>{void this.motorOff(local.reason).catch(()=>{});};local.addEventListener('abort',abort,{once:true});
  void (async()=>{
   try{this.#check(local);return await this.#maintainStationaryClocks(local);}
   catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Paused clock maintenance and stop failed');}throw error;}
   finally{local.removeEventListener('abort',abort);this.#pausedClock=undefined;}
  })().then(done.resolve,done.reject);return done.promise;
 }
 async #awaitPausedClock(signal:AbortSignal):Promise<void>{
  const pending=this.#pausedClock;if(!pending)return;
  const abort=()=>{void this.motorOff(signal.reason).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  try{await pending;this.#check(signal);}finally{signal.removeEventListener('abort',abort);}
 }
 get idleClockMaintenanceDue():boolean{
  if(this.#failed||this.#busy||this.#pause||this.#resuming||this.#pausedBusy||this.#admission.pending)return false;
  const state=this.#g.source.status;
  return !state.busy&&!state.pendingBoundaries&&(!state.seeded||state.paused)&&this.#g.clockMaintenanceDue();
 }
 /** Lazy lookahead commit, with MCU-time pacing but no forced stop boundary. */
 flush(signal:AbortSignal){return this.#operate('stream',signal,async s=>{const state=this.#g.source.status;if(!this.#admission.pending&&state.pendingBoundaries&&(state.paused||!state.seeded)){await this.#drain(s);return;}await this.#streamer.append(this.#admission.flush(true),s);});}
 drain(signal:AbortSignal){return this.#operate('drain',signal,s=>this.#drain(s));}
 /** A zero-velocity trajectory interval, paced by the same native streamer.
  * No host sleep or physical drain is inserted between adjacent source rows. */
 dwell(seconds:number,signal:AbortSignal){
  if(!Number.isFinite(seconds)||seconds<0||seconds>3600)return Promise.reject(new RangeError('Invalid dwell duration'));
  return this.#operate('stream',signal,s=>{const moves=this.#admission.flush();if(seconds)moves.push(dwellMove(this.#o.limits,this.#admission.plannedPosition,seconds));return this.#streamer.append(moves,s);});
 }
 /** A confirmed paused stop already crossed the MCU boundary. Heating may be
  * adjusted there without resuming the retained trajectory or parking moves. */
 async heaterBoundary(signal:AbortSignal):Promise<void>{
  this.#check(signal);
  if(!this.#pause){await this.drain(signal);return;}
  if(this.#pausedClock)await this.#awaitPausedClock(signal);
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
  this.assertActive();if(!this.#pauseReady||this.#resuming||this.#pausedBusy||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused'||!this.#g.source.status.paused&&!this.#pausedClock)throw new Error('Native stream is not available for paused motion');
  if(!Array.isArray(legs)||legs.length>64)throw new RangeError('Invalid paused motion path');
  const admission=this.#newAdmission(this.#g.source.status.position,true);
  for(const leg of legs){admission.move(leg.position,leg.speed);admission.flush();}
 }
 async movePaused(position:readonly number[],speed:number,signal:AbortSignal):Promise<void>{
  this.#check(signal);if(!this.#pauseReady||this.#resuming||this.#pauseMode!=='stationary'&&this.#streamer.status.pause!=='paused')throw new Error('Native stream is not paused');
  if(this.#pausedBusy)throw new Error('Paused motion is busy');
  const target=[...position];this.#pausedBusy=true;const idle=Promise.withResolvers<void>();this.#pausedIdle=idle.promise;
  const combined=AbortSignal.any([signal,this.#abort.signal]),abort=()=>{void this.motorOff(combined.reason).catch(()=>{});};combined.addEventListener('abort',abort,{once:true});
  try{
   if(this.#pausedClock)await this.#awaitPausedClock(combined);
   this.#check(combined);if(!this.#g.source.status.paused)throw new Error('Paused source is not drained');
   const admission=this.#newAdmission(this.#g.source.status.position,true);admission.move(target,speed);const moves=admission.flush();
   if(moves.length){await new RebuiltMotionStreamer(this.#g).append(moves,combined);this.#check(combined);await this.#g.source.drain([],combined);}
   this.#check(combined);
  }catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Paused motion and stop failed');}throw error;}
  finally{combined.removeEventListener('abort',abort);this.#pausedBusy=false;idle.resolve();}
 }
 /** Resolves after live guards and fresh motion lead are established, before
  * the held flush/drain completes its retained trajectory. */
 async resumeStream(signal:AbortSignal):Promise<void>{
  if(this.#pausedClock)await this.#awaitPausedClock(signal);
  this.#check(signal);if(!this.#pauseReady||this.#resuming)throw new Error('Native stream is not paused');
  if(this.#pausedBusy)throw new Error('Paused motion is busy');
  const current=this.#g.source.status;if(!current.paused||!this.#pausePosition||current.position.length!==this.#pausePosition.length||current.position.some((v,i)=>v!==this.#pausePosition![i]))throw new Error('Must return to the drained pause position before resuming',{cause:{current,expected:this.#pausePosition}});
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
  const target=[...position];return this.#operate('rebase',signal,s=>this.#rebase(target,s));
 }
 async #rebase(target:readonly number[],s:AbortSignal){
   await this.#drain(s);const g=this.#g,routes=g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}));
   let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
   try{
    if(target.length!==4||!target.every(Number.isFinite))throw new RangeError('Invalid forced XYZE position');
    const emitters=recoveryEmitters(g.motion.bindings,this.#o.emitters),boundaryTransfer=g.releaseBoundaryOutput();
    motion=(await new CoordinateRebase({coordinator:g.coordinator,bindings:g.motion.bindings,members:g.members,emitters,locate:()=>({queues:routes.map(r=>({id:r.id,position:(r.extrusionAxis===undefined?target.slice(0,3):[target[r.extrusionAxis],0,0]) as [number,number,number]})),printTime:this.#futureTime()})}).recover(s)).motion;
    this.#check(s);const next=await bindRebuiltMotion({group:g.group,clockTimelines:g.clockTimelines,members:g.members,auxiliaryMCUs:g.auxiliaryMCUs,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis})),position:target,boundaryTransfer,motorEnable:g.motorEnable});this.#adopt(next,target,s);
   }catch(error){motion?.dispose();throw error;}
 }
 /** Privileged probe owner supplies separately configured stop groups. Never
  * infer that a Z homing switch is a bed probe. Coordinates here are physical. */
 probeConfiguredZ(z:number,speed:number,signal:AbortSignal){
  if(!this.#o.probeGroups)return Promise.reject(new Error('No configured probe'));
  return this.probeZ(z,speed,this.#o.probeGroups,signal);
 }
 probeZ(z:number,speed:number,groups:LinearSeekOptions['groups'],signal:AbortSignal){
  const owned=groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}));
  return this.#operate('seek',signal,s=>this.#probeZ(z,speed,owned,s));
 }
 probeConfiguredSamples(z:number,speed:number,options:ProbeSamples,signal:AbortSignal){
  const policy={...options};
  return this.#operate('probe-samples',signal,s=>{
   if(!this.#o.probeGroups)throw new Error('No configured probe');
   return collectProbeSamples(policy,()=>this.#probeZ(z,speed,this.#o.probeGroups!,s),async(target,liftSpeed)=>{
    const halt=await new HomingRetractExecution(this.#g,this.#o.kinematics).run(target,liftSpeed,2,s);this.#check(s);
    const next=this.#newAdmission(halt);this.#admission.shutdown(new Error('Probe retract completed'));this.#admission=next;
   },s);
  });
 }
 async #probeZ(z:number,speed:number,owned:LinearSeekOptions['groups'],s:AbortSignal){
   if(this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Probe requires all axes homed');
   const start=this.homingPosition(),target=[...start];target[2]=z;
   if(!Number.isFinite(z)||z>=start[2])throw new RangeError('Probe target must be below the physical start');
   this.#o.kinematics.planHomingAxisMove(start,target,speed,2);
   await this.#drain(s);
   if(!owned.length||owned.length>16)throw new Error('Invalid probe stop groups');
   for(const group of owned){
    const binding=group.members[group.primary],primary=binding&&this.#g.members[binding.physicalMember];
    if(!primary)throw new Error('Invalid probe primary MCU');
    group.endstop.assertDictionary(primary.session.dictionary);
    const reply=await primary.session.queryOnQueue(primary.queue,group.endstop.query(),'endstop_state',s,{oid:group.endstop.oid});
    const state=group.endstop.decode(reply.message);
    if(!state||state.homing||state.triggered)throw new Error('Probe is already triggered or sampling');
   }
   await this.#rebase(start,s);
   const result=await new LinearHomingSeek({...this.#o,generation:this.#g,groups:owned,mode:'probe'}).run(target,speed,2,s);
   try{this.#adopt(result.generation,result.position,s);return Object.freeze({trigger:result.triggerPosition,halt:result.position});}catch(error){result.motion.dispose();throw error;}
 }
 home(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal):Promise<HomingPass>{
  const target=[...position];return this.#operate('seek',signal,async s=>{
   const result=await new LinearHomingSeek({...this.#o,generation:this.#g,groups:this.#o.groupsByAxis[axis],mode:'home'}).run(target,speed,axis,s);
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
   await Promise.all([this.#idle,this.#pausedIdle,this.#pausedClock?.catch(()=>{})]);
   try{this.#unsubscribeGroup?.();this.#g.motion.dispose();}catch(error){errors.push(error);}
   if(errors.length===1)throw errors[0];
   if(errors.length)throw new AggregateError(errors,'Native motion disposal failed');
  })().then(done.resolve,done.reject);
  return done.promise;
 }
}
