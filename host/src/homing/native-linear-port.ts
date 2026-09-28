import {carriageHomingOrder} from '../kinematics/dual-carriage.ts';
import {DualCarriageLinearKinematics} from '../kinematics/dual-carriage-linear.ts';
import {nativeCarriageTransforms,carriageSolvers} from '../kinematics/dual-carriage-projection.ts';
import type {CarriageMode} from '../kinematics/dual-carriage.ts';
import type {CoordinateRebaseOptions} from './recovery.ts';
import type {GCodeFileIdentity} from '../gcode/file-reader.ts';
import {DeltaKinematics} from '../kinematics/delta.ts';
import type {LinearKinematics} from '../kinematics/linear.ts';
import {calculateScrewTilt,type ScrewDirection} from '../motion/screws-tilt.ts';
import type {ScrewsTiltPlan} from '../config/screws-tilt.ts';
import {SkewCorrection,type SkewFactors} from '../motion/skew.ts';
import type {QuadGantryCalibrationPlan} from '../config/quad-gantry.ts';
import {planQuadGantry} from '../motion/quad-gantry.ts';
import type {planZAdjustments} from '../motion/z-adjustments.ts';
import type {ZTiltCalibrationPlan} from '../config/z-tilt.ts';
import {planZTilt,type ZTiltMotor} from '../motion/z-tilt.ts';
import type {StoppedEmitter} from './rebuild-motion.ts';
import {BedTilt,fitBedTilt} from '../motion/bed-tilt.ts';
import type {BedTiltProbePlan} from '../config/bed-tilt.ts';
import type {BLTouchDevice,BLTouchSample} from './bltouch-device.ts';
import type {EndstopProtocol} from '../inputs/endstop.ts';
import type {SafeZHoming} from './safe-z-home.ts';
import {probeHomingPosition} from './probe-home.ts';
import {endstopPhasePosition} from './endstop-phase-position.ts';
import type {ConfiguredEndstopPhase} from '../config/endstop-phase.ts';
import {observedStepperPosition} from '../motion/observed-position.ts';
import {planProbeGrid,measureProbeGrid,type ProbeGrid} from './probe-grid.ts';
import type {ProbeConfiguration} from '../config/probe.ts';
import {collectProbeSamples,type ProbeSamples} from './probe-samples.ts';
import {nativeBedMeshStatus} from '../runtime/native-bed-mesh-status.ts';
import {BedMesh} from '../motion/bed-mesh.ts';
import type {BedMeshFadeConfig} from '../motion/bed-mesh-fade.ts';
import {StopNotice} from '../runtime/stop-notice.ts';
import {dwellMove} from '../motion/dwell.ts';
import type {LinearHomingPort,LinearHomingRail,HomingPass} from './linear-command.ts';
import {LinearHomingSeek,type LinearSeekOptions} from './linear-seek.ts';
import {HomingRetractExecution} from './retract-execution.ts';
import {CoordinateRebase} from './recovery.ts';
import {bindRebuiltMotion} from '../runtime/rebuilt-motion.ts';
import {createGuardedBedMeshPort,createMotionValidator,createMultiExtrusionMeshPort,createMultiExtrusionValidator,type GuardedBedMeshOptions,type ExtrusionAxisPolicy} from '../motion/guarded-bed-mesh-port.ts';
import type {ExtrusionGuard} from '../motion/extrusion.ts';
import type {MotionLimits} from '../motion/lookahead.ts';
import {VelocityLimits,VelocityUpdateUnavailable,type VelocitySettings,type VelocityUpdate} from '../motion/velocity-limits.ts';
import type {Axis} from '../kinematics/linear.ts';
import {RebuiltMotionStreamer,type StreamPause} from '../runtime/motion-streamer.ts';
import {serialClock} from '../protocol/serial-queue.ts';
import {recoveryEmitters} from './recovery-emitters.ts';
import {copyPressureWindowChanges,pressureAdvanceSettings,planPressureAdvance,type PressureWindowChange,type PressureAdvanceSettings} from '../motion/pressure-advance-settings.ts';
export interface NativeLinearPortOptions extends Omit<LinearSeekOptions,'groups'|'mode'|'kinematics'> {
 kinematics:LinearKinematics|DeltaKinematics;
 carriages?:{homingRails?:readonly [LinearHomingRail,LinearHomingRail];emitterIds:readonly [string,string];groups:readonly [LinearSeekOptions['groups'],LinearSeekOptions['groups']]};
 skewProfiles?:Readonly<Record<string,Readonly<SkewFactors>>>;
 bedTilt?:BedTilt;
 endstopPhases?:readonly ConfiguredEndstopPhase[];
 probeConfiguration?:Readonly<ProbeConfiguration>;
 safeZHoming?:Readonly<SafeZHoming>;
 probeDevice?:Readonly<{device:BLTouchDevice;endstop:EndstopProtocol}>;
 probeHoming?:Readonly<{minimumZ:number;offset:number}>;
 probeGroups?:LinearSeekOptions['groups'];
 groupsByAxis:readonly [LinearSeekOptions['groups'],LinearSeekOptions['groups'],LinearSeekOptions['groups']];
 extruders?:readonly ExtrusionAxisPolicy[];
 limits:MotionLimits;extrusion:ExtrusionGuard;canExtrude:()=>boolean;
 velocitySettings?:Pick<VelocitySettings,'squareCornerVelocity'|'minCruiseRatio'>;
}
interface RebaseLayout {carriageTransforms?:CoordinateRebaseOptions['carriageTransforms'];routes:readonly {id:string;extrusionAxis?:number;stationaryPosition?:readonly [number,number,number]}[];emitters:readonly StoppedEmitter[];}
export interface PausedMove {position:readonly number[];speed:number;}
/** Native XYZE port for LinearHomingCommand. The runtime must provide configured
 * MCU/actuator ownership and a live thermal guard. Ordinary moves are admitted
 * to lookahead; flush paces a rolling prefix and drain waits for MCU time.
 * The runtime must arrange timely checkpoints and final drain. Mesh lifecycle
 * and product startup remain separate runtime responsibilities. */
export class NativeLinearHomingPort implements LinearHomingPort {
 #phaseRevision=0n;
 endstopPhaseCalibration(){
  return {revision:String(this.#phaseRevision),steppers:(this.#o.endstopPhases??[]).map(owner=>{
   const last=owner.alignment.status.last,statistics=owner.alignment.statistics;
   return {name:owner.name??owner.id,primary:this.#o.kinematicIds.includes(owner.id),correction_enabled:!owner.statsOnly,trigger_phase:owner.statsOnly?null:owner.alignment.status.triggerPhase,last_phase:last?.phase??null,last_mcu_position:last?String(last.mcuPosition):null,samples:statistics?String(statistics.samples):'0',calibration:statistics?{phase:statistics.phase,phases:statistics.phases,low:statistics.low,high:statistics.high,cost:String(statistics.cost)}:null};
  })};
 }
 #lastHoming:{pass:HomingPass;axis:Axis;generation:NativeLinearPortOptions['generation'];counts:readonly {id:string;trigger:bigint}[]}|undefined;
 #o:NativeLinearPortOptions;#g:NativeLinearPortOptions['generation'];#admission:ReturnType<typeof createGuardedBedMeshPort>;
 #meshStatus=nativeBedMeshStatus(null,'');
 get bedMeshStatus(){return this.#meshStatus;}
 /** Query this generation only. An old event outside retained coverage returns
  * undefined; callers must never substitute the queued endpoint. The generation
  * token changes when homing/rebase replaces the pulse/coordinate history. */
 observedActuatorPosition(id:string,eventtime:number){
  this.assertActive();if(!Number.isFinite(eventtime)||eventtime<0||eventtime>serialClock.now())throw new RangeError('Invalid actuator observation time');
  const binding=this.#g.motion.bindings.find(b=>b.id===id);if(!binding)throw new RangeError('Unknown observed actuator');
  const clock=this.#g.members[binding.member].session.clock;clock.assertActive();
  const tick=clock.sync.getClock(eventtime),position=observedStepperPosition(binding.history,binding.position,tick);
  return position===undefined?undefined:Object.freeze({position,clock:tick,generation:binding.history});
 }

 #skew:SkewCorrection|undefined;#skewRevision=0n;
 #tilt:BedTilt|undefined;
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
  if(o.kinematics instanceof DeltaKinematics&&(o.probeHoming||o.safeZHoming||o.endstopPhases?.length))throw new Error('Delta probe and phase adapters are not configured');
  if(o.probeDevice&&(o.probeGroups?.length!==1||o.probeGroups[0].endstop!==o.probeDevice.endstop||o.probeDevice.device.status.phase!=='idle'))throw new Error('Probe device must own the configured sensor and be initialized');
  if(o.probeHoming&&(!Number.isFinite(o.probeHoming.minimumZ)||!Number.isFinite(o.probeHoming.offset)||o.probeHoming.offset<o.probeHoming.minimumZ||o.groupsByAxis[2].length!==1||o.probeGroups?.length!==1||o.groupsByAxis[2][0].endstop!==o.probeGroups[0].endstop))throw new Error('Invalid probe homing configuration or ownership');
  if(o.groupsByAxis.length!==3)throw new Error('Three homing axis configurations required');
  if(o.kinematics instanceof DualCarriageLinearKinematics){
   const c=o.carriages,k=o.kinematics,modes=carriageSolvers(k.geometry),transforms=nativeCarriageTransforms(k.geometry,k.carriages);
   if(!c||c.emitterIds.length!==2||new Set(c.emitterIds).size!==2||c.groups.length!==2||c.groups.some(g=>!g.length)||o.kinematicIds[k.geometry.axis]!==c.emitterIds[k.primary])throw new Error('Invalid dual carriage port ownership');
   if(c.homingRails){
    if(c.homingRails.length!==2)throw new Error('Two carriage homing rails required');
    for(const [i,r] of c.homingRails.entries())if(r.endstop!==k.geometry.rails[i].endstop||r.positiveDirection!==k.geometry.rails[i].positiveDirection||![r.speed,r.secondSpeed,r.retractSpeed].every(v=>Number.isFinite(v)&&v>0)||!Number.isFinite(r.retractDistance)||r.retractDistance<0||r.endstops.length!==c.groups[i].length||new Set(r.endstops).size!==r.endstops.length||r.endstops.some(n=>typeof n!=='string'||!n.length||n.length>128||/[\r\n\0]/.test(n)))throw new Error('Invalid dual carriage homing rail');
   }
   for(let i=0;i<2;i++){const e=o.emitters.find(e=>e.id===c.emitterIds[i]),b=o.generation.motion.bindings.find(b=>b.id===c.emitterIds[i]),live=b?.stepper.recoveryFilters().carriage;
    if(e?.mode!==modes[i]||e.queueId!==o.emitters.find(e=>e.id===c.emitterIds[0])?.queueId||!b||!o.generation.routes.some(r=>r.queue===b.queue&&r.extrusionAxis===undefined&&r.stationaryPosition===undefined)||!c.groups[i].some(g=>g.members.some(m=>m.emitters.includes(c.emitterIds[i])))||!live||Object.keys(transforms[i]).some(key=>live[key as keyof typeof live]!==transforms[i][key as keyof typeof live]))throw new Error('Native carriage solvers differ from configured state');
   }
  }else if(o.carriages)throw new Error('Carriage ownership requires dual carriage kinematics');
  this.#velocity=new VelocityLimits(o.limits,o.velocitySettings);
  this.#o={...o,extruders:o.extruders?.map(p=>({...p})),carriages:o.carriages?{homingRails:o.carriages.homingRails?structuredClone(o.carriages.homingRails):undefined,emitterIds:[...o.carriages.emitterIds],groups:o.carriages.groups.map(gs=>gs.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))) as unknown as NonNullable<NativeLinearPortOptions['carriages']>['groups']}:undefined,probeDevice:o.probeDevice?Object.freeze({...o.probeDevice}):undefined,probeHoming:o.probeHoming?Object.freeze({...o.probeHoming}):undefined,endstopPhases:o.endstopPhases?.map(p=>({...p})),probeConfiguration:o.probeConfiguration?structuredClone(o.probeConfiguration):undefined,probeGroups:o.probeGroups?.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))})),emitters:structuredClone(o.emitters),kinematicIds:[...o.kinematicIds],limits:{...o.limits},groupsByAxis:o.groupsByAxis.map(groups=>groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}))) as unknown as NativeLinearPortOptions['groupsByAxis']};
  this.#tilt=o.bedTilt?new BedTilt(o.bedTilt.adjust):undefined;
  this.#g=o.generation;this.#streamer=new RebuiltMotionStreamer(this.#g);this.#admission=this.#newAdmission(this.#g.source.status.position);this.assertActive();this.#watchGroup();
  for(const b of this.#g.motion.bindings){const p=b.stepper.recoveryFilters().pressureAdvance;if(p)this.#pressure.set(b.id,pressureAdvanceSettings(p.advance,p.smoothTime));}
 }
 get carriageStatus(){const k=this.#o.kinematics;return k instanceof DualCarriageLinearKinematics?{primary:k.primary,carriages:k.carriages,homed:k.homedCarriages}:undefined;}
 get carriageGeneration():unknown{return this.#g;}
 validateCarriageMode(index:0|1,mode:CarriageMode):void{const k=this.#o.kinematics;if(!(k instanceof DualCarriageLinearKinematics))throw new Error('Dual carriage is not configured');k.planMode(this.homingPosition()[k.geometry.axis],index,mode);}
 get carriageHoming():LinearHomingPort['carriageHoming']{const k=this.#o.kinematics,c=this.#o.carriages;if(!(k instanceof DualCarriageLinearKinematics)||!c?.homingRails)return undefined;return {axis:k.geometry.axis,primary:k.primary,order:carriageHomingOrder(k.geometry.rails),rails:structuredClone(c.homingRails),select:(index,signal)=>this.#carriageMode(index,'PRIMARY',signal,true)};}
 setCarriageMode(index:0|1,mode:CarriageMode,signal:AbortSignal):Promise<void>{return this.#carriageMode(index,mode,signal,false);}
 #carriageMode(index:0|1,mode:CarriageMode,signal:AbortSignal,homing:boolean):Promise<void>{
  const k=this.#o.kinematics,c=this.#o.carriages;if(!(k instanceof DualCarriageLinearKinematics)||!c)return Promise.reject(new Error('Dual carriage is not configured'));
  // Reject invalid user proposals before entering a transaction that owns IO.
  const propose=(position:number)=>homing?k.planHomingPrimary(position,index):k.planMode(position,index,mode);
  propose(this.homingPosition()[k.geometry.axis]);
  return this.#operate('carriage',signal,async s=>{
   const target=[...this.homingPosition()],plan=propose(target[k.geometry.axis]);target[k.geometry.axis]=plan.position;
   const transforms=nativeCarriageTransforms(k.geometry,plan.carriages),g=this.#g;
   await this.#rebase(target,s,{emitters:this.#o.emitters,routes:g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis,stationaryPosition:r.stationaryPosition})),carriageTransforms:transforms.map((transform,i)=>({id:c.emitterIds[i],transform}))});
   k.commitCarriages(plan.carriages);const ids=[...this.#o.kinematicIds] as [string,string,string];ids[k.geometry.axis]=c.emitterIds[k.primary];this.#o.kinematicIds=ids;
   const groups=[...this.#o.groupsByAxis];groups[k.geometry.axis]=c.groups[k.primary];this.#o.groupsByAxis=groups as unknown as NativeLinearPortOptions['groupsByAxis'];
  });
 }
 subscribeStop(listener:(cause:unknown)=>void):()=>void{return this.#notice.subscribe(listener);}
 usesKinematics(kinematics:NativeLinearPortOptions['kinematics']):boolean{return this.#o.kinematics===kinematics;}
 #watchGroup(){this.#unsubscribeGroup?.();this.#unsubscribeGroup=this.#g.group.subscribeStop(cause=>{void this.motorOff(cause).catch(()=>{});});}
 #createAdmission(options:GuardedBedMeshOptions){return this.#o.extruders?createMultiExtrusionMeshPort({...options,extruders:this.#o.extruders}):createGuardedBedMeshPort(options);}
 #newAdmission(position:readonly number[],physical=false){return this.#createAdmission({skew:physical?undefined:this.#skew,tilt:physical?undefined:this.#tilt,mesh:physical?null:this.#mesh,...this.#meshSettings,physicalPosition:position,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});}
 get skewStatus(){return {configured:this.#o.skewProfiles!==undefined,factors:{...(this.#skew?.factors??{xy:0,xz:0,yz:0})},revision:String(this.#skewRevision)};}
 setSkew(factors:SkewFactors|undefined,signal:AbortSignal):Promise<void>{
  if(this.#o.skewProfiles===undefined)return Promise.reject(new Error('Skew correction is not configured'));
  const next=factors?new SkewCorrection(factors):undefined;
  return this.#operate('skew',signal,async s=>{
   const admission=this.#createAdmission({skew:next,tilt:this.#tilt,mesh:this.#mesh,...this.#meshSettings,physicalPosition:this.homingPosition(),limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});
   await this.#drain(s);this.#check(s);this.#admission.shutdown(new Error('Skew generation replaced'));this.#admission=admission;this.#skew=next;this.#skewRevision++;
  });
 }
 get safeZHoming(){return this.#o.safeZHoming;}
 get status(){return {busy:this.#busy,phase:this.#phase,failed:this.#failed,fault:this.#fault,observerErrors:this.#notice.errors,pendingMoves:this.#admission.pending,stream:this.#streamer.status,pauseMode:this.#pauseMode,pausedMotion:this.#pausedBusy,pausedClockMaintenance:this.#pausedClock!==undefined,pausePosition:this.#pausePosition?[...this.#pausePosition]:undefined};}
 assertActive(){if(this.#failed)throw new Error('Native motion port stopped',{cause:this.#fault});this.#g.group.assertActive();}
 /** Last planned coordinates remain readable after stop; they are not measured position. */
 position(){return this.#admission.logicalPosition;}
 phaseOffsetPosition(id:string,offset:number):number|null{
  if(this.#failed)return null;const binding=this.#g.motion.bindings.find(b=>b.id===id);
  if(!binding||!Number.isInteger(offset)||offset<0||offset>=1024)throw new Error('Invalid phase position binding');
  return binding.position.commandedPosition(BigInt(offset));
 }
 homingPosition(){return this.#admission.plannedPosition;}
 #meshFile:Readonly<GCodeFileIdentity>|undefined;
 get bedMeshFileBound(){return this.#meshFile!==undefined;}
 assertBedMeshFile(identity:Readonly<GCodeFileIdentity>){if(this.#meshFile&&Object.keys(this.#meshFile).some(k=>this.#meshFile![k as keyof GCodeFileIdentity]!==identity[k as keyof GCodeFileIdentity]))throw new Error('Adaptive mesh belongs to another or modified print file');}
 currentBedMesh(){return this.#mesh?.copy()??null;}
 async offsetBedMesh(x:number|null,y:number|null,toolOffset:number|null,signal:AbortSignal):Promise<boolean>{
  this.assertActive();signal.throwIfAborted();
  if([x,y,toolOffset].some(v=>v!==null&&!Number.isFinite(v)))throw new RangeError('Invalid mesh offset');
  const mesh=this.currentBedMesh();if(!mesh)return false;
  mesh.setOffsets(x,y);const settings=structuredClone(this.#meshSettings);
  if(toolOffset!==null)settings.fadeConfig={...settings.fadeConfig,toolOffset};
  await this.replaceBedMesh(mesh,settings,signal,String(this.#meshStatus.profile_name),this.#meshFile);return true;
 }
 replaceBedMesh(mesh:BedMesh|null,settings:{fadeConfig?:BedMeshFadeConfig;splitDeltaZ?:number;checkDistance?:number},signal:AbortSignal,profileName='',fileIdentity?:Readonly<GCodeFileIdentity>):Promise<void>{
  if(typeof profileName!=='string'||profileName.length>128||/[\x00-\x1f\x7f]/.test(profileName))return Promise.reject(new RangeError('Invalid mesh profile name'));
  const file=mesh&&fileIdentity?Object.freeze({...fileIdentity}):undefined;
  const owned=mesh?.copy()??null,options=structuredClone(settings),status=nativeBedMeshStatus(owned,profileName);
  return this.#operate('mesh',signal,async s=>{
   const next=this.#createAdmission({skew:this.#skew,tilt:this.#tilt,mesh:owned,...options,physicalPosition:this.#admission.plannedPosition,limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});
   await this.#drain(s);this.#check(s);this.#admission.shutdown(new Error('Mesh generation replaced'));this.#mesh=owned;this.#meshSettings=options;this.#admission=next;this.#meshStatus=status;this.#meshFile=file;
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
 get hasCoolingFan():boolean{const output=this.#g.boundaryOutput;return !!output&&(output.names===undefined||output.names.includes('fan'));}
 get servoNames():readonly string[]{return (this.#g.boundaryOutput?.names??[]).filter(n=>n.startsWith('servo ')).map(n=>n.slice(6));}
 queueServoValue(name:string,value:number,signal:AbortSignal):Promise<void>{return this.#operate('output',signal,async()=>{
  const output=this.#g.boundaryOutput,route='servo '+name;if(!output?.names?.includes(route))throw new Error('Servo is not configured');
  const id=output.register(value,route);if(!this.#admission.markPendingBoundary(id))this.#g.source.markBoundary(id);
 });}
 get outputPinNames():readonly string[]{return (this.#g.boundaryOutput?.names??[]).filter(n=>n.startsWith('output_pin ')).map(n=>n.slice(11));}
 queueOutputPin(name:string,value:number,signal:AbortSignal):Promise<void>{return this.#operate('output',signal,async()=>{
  const output=this.#g.boundaryOutput,route='output_pin '+name;if(!output?.names?.includes(route))throw new Error('Output pin is not configured');
  const id=output.register(value,route);if(!this.#admission.markPendingBoundary(id))this.#g.source.markBoundary(id);
 });}
 get hasMotorEnable():boolean{return this.#g.motorEnable!==undefined;}
 get canReleaseMotors():boolean{return this.#g.motorEnable?.canReleaseAll??false;}
 releaseMotors(signal:AbortSignal):Promise<void>{if(this.#g.motorEnable&&!this.canReleaseMotors)return Promise.reject(new Error('Always-on motors cannot be released by software'));return this.#operate('release',signal,async s=>{
  const power=this.#g.motorEnable;if(!power)throw new Error('Motor enables are not configured');
  await this.#drain(s);this.#g.assertMotorCalibration();this.#o.kinematics.clearHoming([0,1,2]);
  this.#zTiltApplied=false;this.#quadGantryApplied=false;await power.disableAll(this.#g.source.status.sourceTime,s);this.#check(s);
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
   if(this.#busy){
    if(['stream','drain'].includes(this.#phase)&&!this.#streamer.status.busy){
     // The prefix has finished submitting; its final drain still owns the
     // port. Join that tail, then establish a stationary pause. File admission
     // is already fenced, so no subsequent command can enter in between.
     const idle=this.#idle,abort=()=>{void this.motorOff(signal.reason).catch(()=>{});};
     signal.addEventListener('abort',abort,{once:true});
     return idle.then(()=>{this.#check(signal);return this.pause(signal);}).finally(()=>signal.removeEventListener('abort',abort));
    }
    return this.pauseStream(signal);
   }
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
  try{if(this.#pauseMode!=='stationary')await this.#streamer.resume(this.#o.extruders?createMultiExtrusionValidator(this.#o.kinematics,this.#o.extruders):createMotionValidator(this.#o));this.#check(signal);this.#pause=undefined;this.#pauseReady=false;this.#pausePosition=undefined;this.#pauseMode=undefined;}
  catch(error){try{await this.motorOff(error);}catch(stop){throw new AggregateError([error,stop],'Native resume and stop failed');}throw error;}
  finally{this.#resuming=false;signal.removeEventListener('abort',abort);}
 }
 #adopt(next:NativeLinearPortOptions['generation'],position:readonly number[],signal:AbortSignal){
  this.#check(signal);if(this.#o.kinematics instanceof DeltaKinematics)this.#o.kinematics.resetPosition();const admission=this.#newAdmission(position);this.#admission.shutdown(new Error('Motion generation replaced'));this.#g=next;this.#streamer=new RebuiltMotionStreamer(next);this.#admission=admission;this.#watchGroup();
 }
 /** Delta loses XY reach near its homed apex; descend vertically before travel.
  * Linear machines retain their current clearance until reaching the next point. */
 manualCalibrationTravelHeight(current:number,height:number):number{
  if(!Number.isFinite(current)||!Number.isFinite(height))throw new RangeError('Invalid manual travel height');
  return this.#o.kinematics instanceof DeltaKinematics?height:Math.max(current,height);
 }
 /** Check the complete physical calibration path without scheduling any steps. */
 preflightManualCalibration(points:readonly (readonly number[])[],height:number,speed:number){
  this.assertActive();if(this.status.busy||this.status.pendingMoves||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Manual path requires idle homed printer');
  if(!Number.isFinite(height)||!Number.isFinite(speed)||speed<=0||points.length<1||points.length>65536)throw new RangeError('Invalid manual path');
  const current=[...this.homingPosition()],admission=this.#newAdmission(current,true);
  try{for(const point of points){if(point.length!==2||!point.every(Number.isFinite))throw new RangeError('Invalid manual point');current[2]=this.manualCalibrationTravelHeight(current[2],height);admission.move([...current],speed);current[0]=point[0];current[1]=point[1];admission.move([...current],speed);current[2]=height;admission.move([...current],speed);admission.flush();}}
  finally{admission.shutdown(new Error('Manual path preflight complete'));}
 }
 /** Physical safe-home travel preserves extrusion and ordinary axis authority. */
 homingTravel(position:readonly number[],speed:number,signal:AbortSignal){
  const target=[...position];return this.#operate('homing-travel',signal,async s=>{
   const start=this.homingPosition();if(target.length!==start.length||target.slice(3).some((v,i)=>v!==start[i+3]))throw new Error('Safe home travel cannot move extra axes');
   const physical=this.#newAdmission(start,true);physical.move(target,speed);
   await this.#drain(s);const moves=physical.flush();
   // An unchanged physical target has no new timeline to drain. The previous
   // drain already settled outputs; replaying its horizon after MCU clock
   // retirement would submit an output horizon in the past.
   if(moves.length){await this.#streamer.append(moves,s);await this.#g.source.drain([],s);}this.#check(s);
   const next=this.#newAdmission(target);this.#admission.shutdown(new Error('Safe home travel completed'));this.#admission=next;
  });
 }
 forcePosition(position:readonly number[],signal:AbortSignal){
  const target=[...position];return this.#operate('rebase',signal,s=>this.#rebase(target,s));
 }
 async #rebase(target:readonly number[],s:AbortSignal,layout?:RebaseLayout){
   await this.#drain(s);const g=this.#g,routes=layout?.routes??g.routes.map(r=>({id:g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis,stationaryPosition:r.stationaryPosition}));
   let motion:Awaited<ReturnType<CoordinateRebase['recover']>>['motion']|undefined;
   try{
    if(target.length!==this.homingPosition().length||!target.every(Number.isFinite))throw new RangeError('Invalid forced XYZE position');
    const emitters=recoveryEmitters(g.motion.bindings,layout?.emitters??this.#o.emitters),boundaryTransfer=g.releaseBoundaryOutput();
    motion=(await new CoordinateRebase({coordinator:g.coordinator,bindings:g.motion.bindings,members:g.members,emitters,carriageTransforms:layout?.carriageTransforms,locate:()=>({queues:routes.map(r=>({id:r.id,position:r.stationaryPosition??(r.extrusionAxis===undefined?target.slice(0,3):[target[r.extrusionAxis],0,0]) as [number,number,number]})),printTime:this.#futureTime()})}).recover(s)).motion;
    this.#check(s);const next=await bindRebuiltMotion({group:g.group,clockTimelines:g.clockTimelines,members:g.members,auxiliaryMCUs:g.auxiliaryMCUs,motion,routes:routes.map(r=>({queue:motion!.queues.find(q=>q.id===r.id)!.queue,extrusionAxis:r.extrusionAxis,stationaryPosition:r.stationaryPosition})),position:target,boundaryTransfer,motorEnable:g.motorEnable});this.#adopt(next,target,s);
   }catch(error){motion?.dispose();throw error;}
 }
 /** Execute measured mechanical corrections under exclusive motion ownership.
  * All Z motors must be named; samples are physical bed coordinates. A failed
  * segment stops the whole group and clears homing instead of resuming print. */
 adjustZTilt(samples:readonly (readonly number[])[],motors:readonly ZTiltMotor[],maximumTravel:number,speed:number,signal:AbortSignal){
  const measured=samples.map(p=>[...p]),pivots=motors.map(m=>({...m}));
  return this.#operate('z-tilt',signal,async s=>{this.#zTiltApplied=false;const plan=await this.#adjustZTilt(measured,pivots,maximumTravel,speed,s);this.#zTiltApplied=true;return plan;});
 }
 async #adjustZTilt(measured:readonly (readonly number[])[],pivots:readonly ZTiltMotor[],maximumTravel:number,speed:number,s:AbortSignal){
   if(((this.#o.kinematics.kind==='corexz'||this.#o.kinematics.kind==='hybrid_corexz')||this.#o.kinematics.kind==='delta')||this.#o.kinematics.status.homedAxes!=='xyz'||!Number.isFinite(speed)||speed<=0)throw new Error('Z tilt requires homed independent Z motors and positive speed');
   const z=this.#o.emitters.filter(e=>e.mode==='z');
   if(z.length!==pivots.length||z.some(e=>!pivots.some(m=>m.id===e.id)))throw new Error('Z tilt must own every independent Z motor');
   await this.#drain(s);const start=[...this.homingPosition()],plan=planZTilt(measured,pivots,start[2],maximumTravel);
   await this.#executeZAdjustment(plan,speed,s);return plan;
 }
 async #executeZAdjustment(plan:ReturnType<typeof planZAdjustments>,speed:number,s:AbortSignal){
   const start=[...this.homingPosition()];
   const bounds=this.#o.kinematics.status;if([plan.finalZ,...plan.segments.map(p=>p.targetZ)].some(v=>v<bounds.axisMinimum[2]||v>bounds.axisMaximum[2]))throw new RangeError('Z tilt exceeds Z axis range');
   const normal:RebaseLayout={emitters:this.#o.emitters,routes:this.#g.routes.map(r=>({id:this.#g.motion.queues.find(q=>q.queue===r.queue)!.id,extrusionAxis:r.extrusionAxis}))};
   if(this.#g.routes.some(r=>r.stationaryPosition))throw new Error('Z tilt requires ordinary motor bindings');
   let fixed='z-tilt-fixed';while(normal.routes.some(r=>r.id===fixed))fixed+='-';
   this.#zTiltApplied=false;this.#quadGantryApplied=false;
   // Mechanical changes invalidate the previous measured surface transform.
   this.#mesh=null;this.#meshFile=undefined;this.#meshStatus=nativeBedMeshStatus(null,'');this.#tilt=undefined;
   this.#admission.shutdown(new Error('Mechanical Z calibration replaces surface compensation'));this.#admission=this.#newAdmission(start);
   for(const segment of plan.segments){
    if(segment.distance===0)continue;
    const active=new Set(segment.motors),position=[...this.homingPosition()],held=Object.freeze(position.slice(0,3)) as readonly [number,number,number];
    const emitters=normal.emitters.map(e=>e.mode==='z'&&!active.has(e.id)?{...e,queueId:fixed}:e),used=new Set(emitters.map(e=>e.queueId));
    await this.#rebase(position,s,{emitters,routes:[...normal.routes.filter(r=>used.has(r.id)),{id:fixed,stationaryPosition:held}]});
    const target=[...position];target[2]=segment.targetZ;
    const halt=await new HomingRetractExecution(this.#g,this.#o.kinematics).run(target,speed,2,s);this.#check(s);
    this.#admission.shutdown(new Error('Z adjustment segment completed'));this.#admission=this.#newAdmission(halt);
   }
   const final=[...this.homingPosition()];final[2]=plan.finalZ;await this.#rebase(final,s,normal);
 }
 #quadGantryApplied=false;
 get quadGantryStatus(){return {applied:this.#quadGantryApplied};}
 adjustQuadGantry(samples:readonly (readonly number[])[],corners:readonly (readonly number[])[],motorIds:readonly string[],maximumTravel:number,speed:number,signal:AbortSignal){
  const measured=samples.map(p=>[...p]),geometry=corners.map(p=>[...p]),ids=[...motorIds];
  return this.#operate('quad-gantry',signal,async s=>{
   this.#quadGantryApplied=false;
   const z=this.#o.emitters.filter(e=>e.mode==='z');
   if((this.#o.kinematics.kind==='corexz'||this.#o.kinematics.kind==='hybrid_corexz')||this.#o.kinematics.status.homedAxes!=='xyz'||z.length!==4||z.some(e=>!ids.includes(e.id))||!Number.isFinite(speed)||speed<=0)throw new Error('Quad gantry requires homed independent four Z motors');
   await this.#drain(s);const plan=planQuadGantry(measured,geometry,ids,this.homingPosition()[2],maximumTravel);
   await this.#executeZAdjustment(plan,speed,s);this.#quadGantryApplied=true;return plan;
  });
 }
 #zTiltApplied=false;
 get zTiltStatus(){return {applied:this.#zTiltApplied};}
 calibrateZTilt(options:ZTiltCalibrationPlan,minimumZ:number,signal:AbortSignal){return this.#calibrateZ(options,minimumZ,signal);}
 calibrateQuadGantry(options:QuadGantryCalibrationPlan,minimumZ:number,signal:AbortSignal){return this.#calibrateZ(options,minimumZ,signal);}
 #calibrateZ(options:ZTiltCalibrationPlan|QuadGantryCalibrationPlan,minimumZ:number,signal:AbortSignal){
  const plan=structuredClone(options),config=this.#o.probeConfiguration;
  return this.#operate('corners' in plan?'quad-gantry-calibration':'z-tilt-calibration',signal,async s=>{
   this.#zTiltApplied=false;this.#quadGantryApplied=false;
   const ids='corners' in plan?plan.motorIds:plan.motors.map(m=>m.id);
   const solve=(samples:readonly (readonly number[])[],z:number)=>'corners' in plan?planQuadGantry(samples,plan.corners,ids,z,plan.maximumTravel):planZTilt(samples,plan.motors,z,plan.maximumTravel);
   if(!config||!this.#o.probeGroups||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Z tilt calibration requires configured probe and homed axes');
   if(!Number.isFinite(plan.horizontalHeight)||!Number.isFinite(plan.travelSpeed)||plan.travelSpeed<=0||!Number.isFinite(minimumZ)||minimumZ>=plan.horizontalHeight||plan.horizontalHeight<config.offsets[2]||!Number.isInteger(plan.retries)||plan.retries<0||plan.retries>30||!Number.isFinite(plan.retryTolerance)||plan.retryTolerance<0||plan.retryTolerance>1)throw new RangeError('Invalid Z tilt calibration travel or retry policy');
   const z=this.#o.emitters.filter(e=>e.mode==='z');if((this.#o.kinematics.kind==='corexz'||this.#o.kinematics.kind==='hybrid_corexz')||z.length!==ids.length||z.some(e=>!ids.includes(e.id)))throw new Error('Z tilt must own every independent Z motor');
   // Probe points are nozzle XY, while fitting uses the probe's bed XY.
   solve(plan.points.map(p=>[p[0]+config.offsets[0],p[1]+config.offsets[1],0]),plan.horizontalHeight);
   const admission=this.#newAdmission(this.homingPosition(),true);
   try{for(const point of plan.points){const target=[...point,plan.horizontalHeight,...this.homingPosition().slice(3)];admission.move(target,plan.travelSpeed);admission.move([target[0],target[1],minimumZ,...target.slice(3)],config.speed);}}
   finally{admission.shutdown(new Error('Z tilt preflight complete'));}
   await this.#drain(s);let previous:number|undefined,increasing=0;
   for(let pass=0;pass<=plan.retries;pass++){
    const samples=await this.#deviceSession(async(sample,ss)=>{
     const points:number[][]=[];
     for(const [x,y] of plan.points){
      const raised=[...this.homingPosition()];raised[2]=Math.max(raised[2],plan.horizontalHeight);await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
      raised[0]=x;raised[1]=y;await this.#probeTravel(raised,plan.travelSpeed,ss);raised[2]=plan.horizontalHeight;await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
      const result=await this.#sampleProbe(minimumZ,config.speed,config.sampling,ss,sample),p=result.position,o=config.offsets;points.push([p[0]+o[0],p[1]+o[1],p[2]-o[2]]);
     }
     const finish=[...this.homingPosition()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await this.#probeTravel(finish,config.sampling.liftSpeed,ss);return points;
    },s);
    const measuredRange=Math.max(...samples.map(p=>p[2]))-Math.min(...samples.map(p=>p[2]));
    if(!Number.isFinite(measuredRange))throw new RangeError('Z tilt measurement range overflow');
    if(previous!==undefined&&measuredRange>previous+1e-7)increasing++;else increasing=Math.max(0,increasing-1);previous=measuredRange;
    if(plan.retries&&increasing>1)throw new Error('Z tilt measured range is increasing');
    const toleranceSatisfied=measuredRange<=plan.retryTolerance;
    if(plan.retries&&!toleranceSatisfied&&pass===plan.retries)throw new Error('Z tilt retry limit exceeded');
    await this.#drain(s);const adjustment=solve(samples,this.homingPosition()[2]);await this.#executeZAdjustment(adjustment,config.sampling.liftSpeed,s);
    if(!plan.retries||toleranceSatisfied){if('corners' in plan)this.#quadGantryApplied=true;else this.#zTiltApplied=true;return {passes:pass+1,samples,measuredRange,toleranceSatisfied,adjustment};}
   }
   throw new Error('Z tilt calibration did not complete');
  });
 }
 /** Privileged probe owner supplies separately configured stop groups. Never
  * infer that a Z homing switch is a bed probe. Coordinates here are physical. */
 probeConfiguredZ(z:number,speed:number,signal:AbortSignal){
  if(!this.#o.probeGroups)return Promise.reject(new Error('No configured probe'));
  return this.probeZ(z,speed,this.#o.probeGroups,signal);
 }
 probeZ(z:number,speed:number,groups:LinearSeekOptions['groups'],signal:AbortSignal){
  const owned=groups.map(g=>({...g,members:g.members.map(m=>({...m,emitters:[...m.emitters]}))}));
  return this.#operate('seek',signal,s=>this.#deviceSession(sample=>sample((ss,onTriggered)=>this.#probeZ(z,speed,owned,ss,onTriggered)),s));
 }
 async measureProbe(z:number,signal:AbortSignal){
  const config=this.#o.probeConfiguration;if(!config)throw new Error('No configured probe settings');
  const result=await this.probeConfiguredSamples(z,config.speed,config.sampling,signal),p=result.position,o=config.offsets;
  const bed=[p[0]+o[0],p[1]+o[1],p[2]-o[2]];
  if(!bed.every(Number.isFinite)){const error=new RangeError('Probe offset overflow');await this.motorOff(error);throw error;}
  return Object.freeze({...result,bedPosition:Object.freeze(bed)});
 }
 probeConfiguredSamples(z:number,speed:number,options:ProbeSamples,signal:AbortSignal){
  const policy={...options};
  return this.#operate('probe-samples',signal,s=>this.#deviceSession((sample,ss)=>this.#sampleProbe(z,speed,policy,ss,sample),s));
 }
 async #deviceSession<T>(run:(sample:BLTouchSample,s:AbortSignal)=>Promise<T>,s:AbortSignal):Promise<T>{
  const owner=this.#o.probeDevice;if(!owner)return run(seek=>seek(s,async()=>{}),s);
  await this.#drain(s);
  const result=await owner.device.session((sample,ss)=>run(async seek=>{
   const value=await sample(seek);this.#check(ss);
   // Stowing may outlast the recovered generation's future baseline.
   if(!owner.device.status.deployed)await this.#rebase(this.homingPosition(),ss);return value;
  },ss),s);
  this.#check(s);await this.#rebase(this.homingPosition(),s);return result;
 }
 #sampleProbe(z:number,speed:number,policy:ProbeSamples,s:AbortSignal,sample:BLTouchSample){
   if(!this.#o.probeGroups)throw new Error('No configured probe');
   return collectProbeSamples(policy,()=>sample((ss,onTriggered)=>this.#probeZ(z,speed,this.#o.probeGroups!,ss,onTriggered)),async(target,liftSpeed)=>{
    const halt=await new HomingRetractExecution(this.#g,this.#o.kinematics).run(target,liftSpeed,2,s,30000,'probe');this.#check(s);
    const next=this.#newAdmission(halt);this.#admission.shutdown(new Error('Probe retract completed'));this.#admission=next;
   },s);
 }
 /** Resolved motor coordinates after a complete drain, matching manual probe
  * step resolution semantics. Integer pulse counts avoid solver round-trip drift.
  * This is commanded pulse history, not an encoder measurement. */
 manualProbePosition(){
  this.assertActive();const source=this.#g.source.status;if(this.#busy||this.#admission.pending||source.seeded&&!source.paused||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Manual probe requires drained homed motion');
  const motors=this.#o.kinematicIds.map(id=>{const binding=this.#g.motion.bindings.find(b=>b.id===id);if(!binding)throw new Error('Missing manual probe motor');return binding.position.commandedPosition(binding.history.status.lastPlannedPosition);});
  return [...this.#o.kinematics.calcPosition([motors[0],motors[1],motors[2]]),this.homingPosition()[3]];
 }
 applyManualBedTilt(samples:readonly (readonly number[])[],signal:AbortSignal){
  const owned=samples.map(p=>[...p]);return this.#operate('manual-bed-tilt',signal,async s=>{
   if(!this.#tilt||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Manual tilt requires configured tilt and homed axes');
   await this.#drain(s);this.#check(s);return this.#applyBedTilt(owned);
  });
 }
 #applyBedTilt(samples:number[][]){
  const tilt=fitBedTilt(samples),next=this.#createAdmission({skew:this.#skew,tilt,mesh:null,physicalPosition:this.homingPosition(),limits:this.#o.limits,kinematics:this.#o.kinematics,extrusion:this.#o.extrusion,canExtrude:this.#o.canExtrude});
  this.#admission.shutdown(new Error('Bed tilt calibration applied'));this.#admission=next;this.#tilt=tilt;this.#tiltRevision++;
  return {adjust:{...tilt.adjust},samples};
 }
 get bedTiltStatus(){return this.#tilt?{...this.#tilt.adjust,revision:String(this.#tiltRevision),calibrated:this.#tiltRevision>0n}:undefined;}
 #tiltRevision=0n;
 measureDeltaCalibration(options:BedTiltProbePlan,minimumZ:number,signal:AbortSignal){
  const config=this.#o.probeConfiguration,plan=structuredClone(options);
  return this.#operate('delta-calibration',signal,async s=>{
   if(this.#o.kinematics.kind!=='delta'||!config||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Delta calibration requires configured probe and homed Delta axes');
   if(!Number.isFinite(plan.horizontalHeight)||!Number.isFinite(plan.travelSpeed)||plan.travelSpeed<=0||!Number.isFinite(minimumZ)||minimumZ>=plan.horizontalHeight||plan.horizontalHeight<config.offsets[2])throw new Error('Invalid Delta calibration travel');
   if(plan.points.length<6||plan.points.length>999||plan.points.some(p=>p.length!==2||!p.every(Number.isFinite)))throw new Error('Invalid Delta calibration points');
   const kinematics=this.#o.kinematics;
   const admission=this.#newAdmission(this.homingPosition(),true);
   try{for(const point of plan.points){const target=[...point,plan.horizontalHeight,this.homingPosition()[3]];admission.move(target,plan.travelSpeed);admission.move([target[0],target[1],minimumZ,target[3]],config.speed);}}
   finally{admission.shutdown(new Error('Delta calibration preflight complete'));}
   await this.#drain(s);
   const samples=await this.#deviceSession(async(sample,ss)=>{
    const points:{height:number;stable:readonly [number,number,number]}[]=[];
    for(const [x,y] of plan.points){
     const raised=[...this.homingPosition()];raised[2]=Math.max(raised[2],plan.horizontalHeight);await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     raised[0]=x;raised[1]=y;await this.#probeTravel(raised,plan.travelSpeed,ss);raised[2]=plan.horizontalHeight;await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     const result=await this.#sampleProbe(minimumZ,config.speed,config.sampling,ss,sample),p=result.position,o=config.offsets;
     points.push({height:o[2],stable:kinematics.stablePosition([p[0],p[1],p[2]])});
    }
    const finish=[...this.homingPosition()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await this.#probeTravel(finish,config.sampling.liftSpeed,ss);return points;
   },s);
   this.#check(s);return samples;
  });
 }
 calibrateBedTilt(options:BedTiltProbePlan,minimumZ:number,signal:AbortSignal){
  const config=this.#o.probeConfiguration,plan=structuredClone(options);
  return this.#operate('bed-tilt',signal,async s=>{
   if(!this.#tilt||!config||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Bed tilt calibration requires configured tilt, probe and homed axes');
   if(!Number.isFinite(plan.horizontalHeight)||!Number.isFinite(plan.travelSpeed)||plan.travelSpeed<=0||!Number.isFinite(minimumZ)||minimumZ>=plan.horizontalHeight||plan.horizontalHeight<config.offsets[2])throw new Error('Invalid bed tilt travel');
   fitBedTilt(plan.points.map(p=>[...p,0]));
   const admission=this.#newAdmission(this.homingPosition(),true);
   try{for(const point of plan.points){const target=[...point,plan.horizontalHeight,this.homingPosition()[3]];admission.move(target,plan.travelSpeed);admission.move([target[0],target[1],minimumZ,target[3]],config.speed);}}
   finally{admission.shutdown(new Error('Bed tilt preflight complete'));}
   await this.#drain(s);
   const samples=await this.#deviceSession(async(sample,ss)=>{
    const points:number[][]=[];
    for(const [x,y] of plan.points){
     const raised=[...this.homingPosition()];raised[2]=Math.max(raised[2],plan.horizontalHeight);await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     raised[0]=x;raised[1]=y;await this.#probeTravel(raised,plan.travelSpeed,ss);raised[2]=plan.horizontalHeight;await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     const result=await this.#sampleProbe(minimumZ,config.speed,config.sampling,ss,sample),p=result.position,o=config.offsets;
     points.push([p[0]+o[0],p[1]+o[1],p[2]-o[2]]);
    }
    const finish=[...this.homingPosition()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await this.#probeTravel(finish,config.sampling.liftSpeed,ss);return points;
   },s);
   this.#check(s);return this.#applyBedTilt(samples);
  });
 }
 measureScrewsTilt(options:ScrewsTiltPlan,minimumZ:number,signal:AbortSignal,direction?:ScrewDirection,maximumDeviation?:number){
  const config=this.#o.probeConfiguration,plan=structuredClone(options);
  return this.#operate('screws-tilt',signal,async s=>{
   if(!config||this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Screw tilt calibration requires configured tilt, probe and homed axes');
   if(!Number.isFinite(plan.horizontalHeight)||!Number.isFinite(plan.travelSpeed)||plan.travelSpeed<=0||!Number.isFinite(minimumZ)||minimumZ>=plan.horizontalHeight||plan.horizontalHeight<config.offsets[2])throw new Error('Invalid bed tilt travel');
   calculateScrewTilt(plan.points.map(()=>0),plan.thread,direction,maximumDeviation);
   if(plan.names.length!==plan.points.length||plan.points.some(p=>p.length!==2||!p.every(Number.isFinite)))throw new Error('Invalid screw tilt plan');
   const admission=this.#newAdmission(this.homingPosition(),true);
   try{for(const point of plan.points){const target=[...point,plan.horizontalHeight,this.homingPosition()[3]];admission.move(target,plan.travelSpeed);admission.move([target[0],target[1],minimumZ,target[3]],config.speed);}}
   finally{admission.shutdown(new Error('Screw tilt preflight complete'));}
   await this.#drain(s);
   const samples=await this.#deviceSession(async(sample,ss)=>{
    const points:number[][]=[];
    for(const [x,y] of plan.points){
     const raised=[...this.homingPosition()];raised[2]=Math.max(raised[2],plan.horizontalHeight);await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     raised[0]=x;raised[1]=y;await this.#probeTravel(raised,plan.travelSpeed,ss);raised[2]=plan.horizontalHeight;await this.#probeTravel(raised,config.sampling.liftSpeed,ss);
     const result=await this.#sampleProbe(minimumZ,config.speed,config.sampling,ss,sample),p=result.position,o=config.offsets;
     points.push([p[0]+o[0],p[1]+o[1],p[2]-o[2]]);
    }
    const finish=[...this.homingPosition()];finish[2]=Math.max(finish[2],plan.horizontalHeight);await this.#probeTravel(finish,config.sampling.liftSpeed,ss);return points;
   },s);
   this.#check(s);return {...calculateScrewTilt(samples.map(p=>p[2]),plan.thread,direction,maximumDeviation),names:[...plan.names],samples,thread:plan.thread};
  });
 }
 async #probeTravel(target:readonly number[],speed:number,s:AbortSignal){
  this.#check(s);if(target.every((v,i)=>v===this.homingPosition()[i]))return;
  const physical=this.#newAdmission(this.homingPosition(),true);physical.move(target,speed);
  await this.#streamer.append(physical.flush(),s);await this.#g.source.drain([],s);this.#check(s);
  const next=this.#newAdmission(target);this.#admission.shutdown(new Error('Probe travel completed'));this.#admission=next;
 }
 measureBedMesh(options:ProbeGrid,minimumZ:number,signal:AbortSignal){
  const config=this.#o.probeConfiguration;if(!config)return Promise.reject(new Error('No configured probe settings'));
  const plan=planProbeGrid(options,config.offsets);
  return this.#operate('probe-grid',signal,async s=>{
   if(this.#o.kinematics.status.homedAxes!=='xyz'||minimumZ>=plan.horizontalHeight||!Number.isFinite(minimumZ))throw new Error('Invalid grid homing or search range');
   // Validate every nozzle XY, travel height and search limit before motion.
   const admission=this.#newAdmission(this.homingPosition(),true);
   for(const point of plan.points){const target=[point.nozzleX,point.nozzleY,plan.horizontalHeight,this.homingPosition()[3]];admission.move(target,plan.travelSpeed);admission.move([target[0],target[1],minimumZ,target[3]],config.speed);}
   admission.shutdown(new Error('Grid preflight complete'));
   await this.#drain(s);
   // Delta homes at the cone apex: descend vertically before the first XY
   // travel so a valid bed point is not attempted at the homing height.
   if(this.#o.kinematics instanceof DeltaKinematics&&this.homingPosition()[2]>plan.horizontalHeight){const target=[...this.homingPosition()];target[2]=plan.horizontalHeight;await this.#probeTravel(target,plan.travelSpeed,s);}
   return this.#deviceSession((sample,ss)=>measureProbeGrid(plan,{position:()=>this.homingPosition(),move:async(target,speed)=>{
    await this.#probeTravel(target,speed,ss);
   },probe:async()=>{const measured=await this.#sampleProbe(minimumZ,config.speed,config.sampling,ss,sample);return measured.position[2]-config.offsets[2];}},ss),s);
  });
 }
 #verifyDeviceMovement(result:Awaited<ReturnType<LinearHomingSeek['run']>>){
  if(this.#o.probeDevice&&result.movingSteppers.some(m=>{const p=result.offsets.find(p=>p.member===m.member&&p.oid===m.oid);return !p||p.start===p.trigger;}))throw new Error('BLTouch triggered without motor movement');
 }
 async #probeZ(z:number,speed:number,owned:LinearSeekOptions['groups'],s:AbortSignal,onTriggered?:()=>Promise<void>){
   if(this.#o.probeDevice&&(owned.length!==1||owned[0].endstop!==this.#o.probeDevice.endstop))throw new Error('Probe device sensor ownership differs');
   if(this.#o.kinematics.status.homedAxes!=='xyz')throw new Error('Probe requires all axes homed');
   const start=this.homingPosition(),target=[...start];target[2]=z;
   if(!Number.isFinite(z)||z>=start[2])throw new RangeError('Probe target must be below the physical start');
   if(this.#o.kinematics instanceof DeltaKinematics)this.#o.kinematics.planProbeAxisMove(start,target,speed,2);
   else this.#o.kinematics.planHomingAxisMove(start,target,speed,2);
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
   const result=await new LinearHomingSeek({...this.#o,generation:this.#g,groups:owned,mode:'probe',onTriggered}).run(target,speed,2,s);
   try{this.#verifyDeviceMovement(result);this.#adopt(result.generation,result.position,s);return Object.freeze({trigger:result.triggerPosition,halt:result.position});}catch(error){result.motion.dispose();throw error;}
 }
 home(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal):Promise<HomingPass>{
  const target=[...position];return this.#operate('seek',signal,async s=>{
   this.#lastHoming=undefined;
   const groups=this.#o.groupsByAxis[axis],modes=[...new Set(groups.flatMap(g=>g.sensorless?[g.sensorless]:[]))];
   if(modes.length){await this.#drain(s);for(const mode of modes)await mode.enter(s);await this.#rebase(this.homingPosition(),s);}
   const probe=axis===2?this.#o.probeHoming:undefined;
   if(probe){if(groups.length!==1||modes.length||!this.#o.kinematics.status.homedAxes.includes('x')||!this.#o.kinematics.status.homedAxes.includes('y'))throw new Error('Probe Z homing requires homed XY and one probe endstop');target[2]=probe.minimumZ;if(target[2]>=this.homingPosition()[2])throw new Error('Probe Z search must descend');}
   const seek=async(onTriggered?:()=>Promise<void>)=>{
    if(probe&&this.#o.probeDevice)await this.#rebase(this.homingPosition(),s);
    const result=await new LinearHomingSeek({...this.#o,generation:this.#g,groups,mode:probe?'probe':'home',onTriggered}).run(target,speed,axis,s);
    try{if(probe)this.#verifyDeviceMovement(result);this.#adopt(result.generation,result.position,s);
     if(probe)await this.#rebase(probeHomingPosition(result.position,result.triggerPosition,probe.offset),s);
     for(const mode of modes)await mode.restore(s);
     if(modes.length)await this.#rebase(result.position,s);
     return result;
    }catch(error){result.motion.dispose();throw error;}
   };
   const result=probe&&this.#o.probeDevice?await this.#deviceSession(sample=>sample((_s,onTriggered)=>seek(onTriggered)),s):await seek();
   this.#lastHoming={pass:result,axis,generation:this.#g,counts:result.triggerCounts};return result;
  });
 }
 finishDeltaHoming(pass:HomingPass,signal:AbortSignal):Promise<void>{
  return this.#operate('delta-homing-complete',signal,async()=>{
   const last=this.#lastHoming;this.#lastHoming=undefined;
   if(!(this.#o.kinematics instanceof DeltaKinematics)||!last||last.pass!==pass||last.axis!==2||last.generation!==this.#g)throw new Error('Stale or foreign Delta homing result');
  });
 }
 finishHoming(pass:HomingPass,axis:Axis,endstop:number,signal:AbortSignal):Promise<void>{
  return this.#operate('phase-correction',signal,async s=>{
   if(this.#o.kinematics instanceof DeltaKinematics)throw new Error('Delta requires simultaneous homing completion');
   const last=this.#lastHoming;this.#lastHoming=undefined;
   if(!last||last.pass!==pass||last.axis!==axis||last.generation!==this.#g)throw new Error('Stale or foreign homing phase result');
   if(axis===2&&this.#o.probeHoming)return;
   const id=this.#o.kinematicIds[axis],owners=this.#o.endstopPhases??[];
   for(const tracked of owners){
    if(!tracked.statsOnly||tracked.id!==id&&!new RegExp('^stepper_'+ 'xyz'[axis]+'\\d+$').test(tracked.name??''))continue;
    const count=last.counts.find(c=>c.id===tracked.id);if(!count)throw new Error('Missing endstop statistics trigger');
    tracked.alignment.observe(count.trigger,tracked.offset());this.#phaseRevision++;
   }
   const owner=owners.find(p=>p.id===id&&!p.statsOnly);if(!owner)return;
   const counter=last.counts.find(c=>c.id===id);if(!counter)throw new Error('Missing endstop phase trigger');
   let adjustment:number;try{adjustment=owner.alignment.adjust(counter.trigger,owner.offset(),endstop);}finally{this.#phaseRevision++;}if(adjustment===0)return;
   const position=[...this.homingPosition()],actuators=this.#o.kinematicIds.map(id=>{
    const binding=this.#g.motion.bindings.find(b=>b.id===id);if(!binding)throw new Error('Missing phase coordinate binding');
    return binding.stepper.coordinatePosition(position[0],position[1],position[2]);
   });
   await this.#rebase(endstopPhasePosition(this.#o.kinematics,position,actuators,axis,adjustment),s);
  });
 }
 retract(position:readonly number[],speed:number,axis:Axis,signal:AbortSignal){
  const target=[...position];return this.#operate('retract',signal,async s=>{
   const halt=await new HomingRetractExecution(this.#g,this.#o.kinematics).run(target,speed,axis,s);this.#check(s);
   const admission=this.#newAdmission(halt);this.#admission.shutdown(new Error('Homing retreat completed'));this.#admission=admission;
  });
 }
 motorOff(cause:unknown):Promise<void>{
  this.#zTiltApplied=false;this.#quadGantryApplied=false;
  if(this.#stop)return this.#stop;this.#failed=true;this.#fault=cause;this.#phase='stopped';this.#admission.shutdown(cause);this.#o.kinematics.clearHoming([0,1,2]);
  const stopped=Promise.withResolvers<void>();this.#stop=stopped.promise;this.#abort.abort(cause);
  void Promise.allSettled([this.#g.drain.stop(cause),...(this.#o.probeDevice?[this.#o.probeDevice.device.stop(cause)]:[])]).then(results=>{const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)stopped.reject(new AggregateError(errors,'Native motion and probe stop failed'));else stopped.resolve();});this.#notice.emit(cause);return this.#stop;
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
