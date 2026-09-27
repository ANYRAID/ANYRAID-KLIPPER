import {SkewCorrection} from './skew.ts';
import {BedTilt} from './bed-tilt.ts';
import {isAsyncFunction,isPromise} from 'node:util/types';
import type {MovePort} from '../gcode/move.ts';
import {BedMesh} from './bed-mesh.ts';
import {BedMeshFade,type BedMeshFadeConfig} from './bed-mesh-fade.ts';
import {splitBedMeshMove} from './bed-mesh-split.ts';
import {Move,LookAheadQueue,type MotionLimits} from './lookahead.ts';
import {markMoveEnd,validateEndMarkers} from './boundary-markers.ts';
import {markPressureBoundary,validatePressureBoundaries,type PressureBoundary} from './pressure-boundaries.ts';
export interface BedMeshPortOptions {
 skew?:SkewCorrection;tilt?:BedTilt;mesh:BedMesh|null;fade?:BedMeshFade;fadeConfig?:BedMeshFadeConfig;physicalPosition:readonly number[];limits:MotionLimits;
 /** Required synchronous kinematic/extrusion checks; may limit speed/acceleration.
  * Must not perform I/O or mutate endpoints or previously admitted moves. */
 validate:(move:Move)=>void;signal?:AbortSignal;splitDeltaZ?:number;checkDistance?:number;
}
/** GCodeMove adapter owning a lookahead queue and an owned mesh snapshot.
 * Physical position means accepted/planned position, not measured MCU position. */
export class BedMeshMovePort implements MovePort {
 #skew:SkewCorrection|undefined;#tilt:BedTilt|undefined;#mesh:BedMesh|null;#fade:BedMeshFade;#limits:MotionLimits;#validate:(move:Move)=>void;
 #logical:number[];#physical:number[];#queue=new LookAheadQueue();#busy=false;#flushDue=false;
 #fault:Error|undefined;#signal:AbortSignal|undefined;
 #onAbort=()=>this.shutdown(this.#signal?.reason);
 #active():void{if(this.#fault)throw this.#fault;}
 #finish():void{this.#busy=false;if(this.#fault){this.#queue.reset();this.#flushDue=false;}}
 #split:{splitDeltaZ:number;checkDistance:number};
 constructor(options:BedMeshPortOptions){
  const {physicalPosition}=options;
  if(options.tilt&&options.mesh)throw new Error('Bed tilt conflicts with mesh');
  this.#skew=options.skew?new SkewCorrection(options.skew.factors):undefined;
  this.#tilt=options.tilt?new BedTilt(options.tilt.adjust):undefined;
  if(options.fade&&options.fadeConfig)throw new RangeError('Specify resolved fade or fadeConfig, not both');
  if(!Array.isArray(physicalPosition)||physicalPosition.length!==4||!physicalPosition.every(Number.isFinite)||typeof options.validate!=='function'||isAsyncFunction(options.validate))throw new RangeError('Invalid mesh port configuration');
  this.#mesh=options.mesh?.copy()??null;this.#fade=options.fade??BedMeshFade.forMesh(this.#mesh,options.fadeConfig);this.#physical=[...physicalPosition];this.#limits={...options.limits,extraAxes:options.limits.extraAxes?[...options.limits.extraAxes]:undefined};this.#validate=options.validate;
  this.#split={splitDeltaZ:options.splitDeltaZ??.025,checkDistance:options.checkDistance??5};
  if(!Number.isFinite(this.#split.splitDeltaZ)||this.#split.splitDeltaZ<.01||!Number.isFinite(this.#split.checkDistance)||this.#split.checkDistance<3)throw new RangeError('Invalid mesh split configuration');
  if(this.#mesh)this.#fade.validateMesh(this.#mesh);
  this.#logical=this.#inverse();new Move(this.#limits,this.#physical,this.#physical,1);
  this.#signal=options.signal;if(this.#signal){this.#signal.addEventListener('abort',this.#onAbort,{once:true});if(this.#signal.aborted)this.#onAbort();}this.#active();
 }
 #idle(){this.#active();if(this.#busy)throw new Error('Mesh motion admission active');}
 #inverse():number[]{const p=this.#tilt?this.#tilt.unapply(this.#physical):[...this.#physical];if(this.#mesh)p[2]=this.#fade.unapply(p[2],this.#mesh.calcZ(p[0],p[1]));return this.#skew?this.#skew.unapply(p):p;}
 position():readonly number[]{this.#idle();const position=this.#inverse();this.#logical=[...position];return position;}
 /** Latches the first cause and drops only host-owned, unflushed motion.
  * Already returned trajectories require a separate downstream hardware stop. */
 shutdown(cause:unknown=new Error('Mesh motion stopped')):void{
  this.#fault??=cause instanceof Error?cause:new Error('Mesh motion stopped',{cause});
  this.#signal?.removeEventListener('abort',this.#onAbort);this.#signal=undefined;
  if(!this.#busy){this.#queue.reset();this.#flushDue=false;}
 }
 get fault():Error|undefined{return this.#fault;}
 get logicalPosition():readonly number[]{return [...this.#logical];}
 get plannedPosition():readonly number[]{return [...this.#physical];}
 get pending():number{return this.#queue.length;}
 get flushDue():boolean{return this.#flushDue;}
 /** Replace future limits without flushing lookahead or mutating queued moves.
  * This owner retains its extrusion junction callbacks. */
 setMotionLimits(limits:MotionLimits):void {
  this.#idle();const next={...limits,extraAxes:this.#limits.extraAxes};new Move(next,this.#physical,this.#physical,1);this.#limits=next;
 }
 /** Attach after all mesh splits, without flushing or changing junction speed.
  * false means the runtime must handle an already-submitted/idle boundary. */
 markPendingBoundary(id:number):boolean{this.#idle();const last=this.#queue.last;if(!last){validateEndMarkers([id]);return false;}markMoveEnd(last,id);return true;}
 markPendingPressureBoundary(change:PressureBoundary):boolean{this.#idle();validatePressureBoundaries([change]);const last=this.#queue.last;if(!last)return false;markPressureBoundary(last,change);return true;}
 move(position:readonly number[],speed:number):void{
  this.#idle();if(!Array.isArray(position)||position.length!==4||!position.every(Number.isFinite)||!Number.isFinite(speed)||speed<=0)throw new RangeError('Invalid mesh motion');
  const logicalTarget=[...position],target=this.#skew?this.#skew.apply(logicalTarget):logicalTarget;this.#busy=true;
  try{
   let endpoints:number[][];
   const factor=this.#mesh?this.#fade.factor(target[2]):0;
   if(this.#tilt)endpoints=[this.#tilt.apply(target)];
   else if(this.#mesh&&factor)endpoints=splitBedMeshMove(this.#mesh,this.#skew?this.#skew.apply(this.#logical):this.#logical,target,{...this.#split,factor,fadeOffset:this.#fade.target});
   else {const end=[...target];if(this.#mesh)end[2]+=this.#fade.target;endpoints=[end];}
   if(this.#queue.length+endpoints.length>100000)throw new RangeError('Mesh lookahead budget exceeded');
   let previous=this.#physical;const staged:Move[]=[];
   for(const end of endpoints){const move=new Move(this.#limits,previous,end,speed);if(move.distance){const outcome:unknown=this.#validate(move);if(outcome!==undefined){if(isPromise(outcome))void outcome.catch(()=>{});throw new TypeError('Motion validator must return synchronously without a value');}this.#active();staged.push(move);}previous=move.endPos;}
   const finalPhysical=[...previous];const due=this.#queue.addBatch(staged);this.#active();
   this.#physical=finalPhysical;this.#logical=logicalTarget;this.#flushDue=due||this.#flushDue;
  }finally{this.#finish();}
 }
 currentMesh():BedMesh|null{this.#idle();return this.#mesh?.copy()??null;}
 /** Drain must submit these old-mesh trajectories and await all downstream
  * movement, including earlier flushes. It must honor cancellation and perform
  * hardware stop on failure; this port can only stop host admission. */
 async replaceMesh(mesh:BedMesh|null,fadeConfig:BedMeshFadeConfig,drain:(moves:Move[],signal:AbortSignal)=>Promise<void>,signal?:AbortSignal):Promise<readonly number[]>{
  this.#idle();if(this.#tilt&&mesh)throw new Error('Bed tilt conflicts with mesh');if(typeof drain!=='function')throw new TypeError('Motion drain required');
  const signals=[this.#signal,signal].filter((s):s is AbortSignal=>s!==undefined),combined=AbortSignal.any(signals);combined.throwIfAborted();
  const next=mesh?.copy()??null,fade=BedMeshFade.forMesh(next,fadeConfig),logical=this.#tilt?this.#tilt.unapply(this.#physical):[...this.#physical];
  if(next)logical[2]=fade.unapply(logical[2],next.calcZ(logical[0],logical[1]));
  const abort=()=>this.shutdown(combined.reason);this.#busy=true;combined.addEventListener('abort',abort,{once:true});
  try{
   const moves=this.#queue.flush(false);this.#flushDue=false;
   await drain(moves,combined);combined.throwIfAborted();this.#active();
   this.#mesh=next;this.#fade=fade;this.#logical=this.#skew?this.#skew.unapply(logical):logical;return [...this.#logical];
  }catch(error){this.shutdown(error);throw this.#fault;}
  finally{combined.removeEventListener('abort',abort);this.#finish();}
 }
 /** Skew is the outer transform: logical -> skew -> mesh/tilt -> physical.
  * Changes drain old trajectories before rebasing logical position. */
 async replaceSkew(skew:SkewCorrection|undefined,drain:(moves:Move[],signal:AbortSignal)=>Promise<void>,signal?:AbortSignal):Promise<readonly number[]>{
  this.#idle();if(typeof drain!=='function')throw new TypeError('Motion drain required');
  const next=skew?new SkewCorrection(skew.factors):undefined;
  const combined=AbortSignal.any([this.#signal,signal].filter((s):s is AbortSignal=>s!==undefined));combined.throwIfAborted();
  const physical=this.#tilt?this.#tilt.unapply(this.#physical):[...this.#physical];
  if(this.#mesh)physical[2]=this.#fade.unapply(physical[2],this.#mesh.calcZ(physical[0],physical[1]));
  const logical=next?next.unapply(physical):physical;
  const abort=()=>this.shutdown(combined.reason);this.#busy=true;combined.addEventListener('abort',abort,{once:true});
  try{
   const moves=this.#queue.flush(false);this.#flushDue=false;
   await drain(moves,combined);combined.throwIfAborted();this.#active();
   this.#skew=next;this.#logical=logical;return [...logical];
  }catch(error){this.shutdown(error);throw this.#fault;}
  finally{combined.removeEventListener('abort',abort);this.#finish();}
 }
 /** Flush for downstream planning; does not send anything to hardware. */
 flush(lazy=false):Move[]{this.#idle();this.#busy=true;try{const moves=this.#queue.flush(lazy);this.#flushDue=false;return moves;}finally{this.#finish();}}
}
