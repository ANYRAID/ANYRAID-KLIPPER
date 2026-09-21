import {isAsyncFunction,isPromise} from 'node:util/types';
import type {MovePort} from '../gcode/move.ts';
import {BedMesh} from './bed-mesh.ts';
import {BedMeshFade} from './bed-mesh-fade.ts';
import {splitBedMeshMove} from './bed-mesh-split.ts';
import {Move,LookAheadQueue,type MotionLimits} from './lookahead.ts';
export interface BedMeshPortOptions {
 mesh:BedMesh|null;fade:BedMeshFade;physicalPosition:readonly number[];limits:MotionLimits;
 /** Required synchronous kinematic/extrusion checks; may limit speed/acceleration.
  * Must not perform I/O or mutate endpoints or previously admitted moves. */
 validate:(move:Move)=>void;splitDeltaZ?:number;checkDistance?:number;
}
/** GCodeMove adapter owning a lookahead queue and a fixed mesh snapshot.
 * Physical position means accepted/planned position, not measured MCU position. */
export class BedMeshMovePort implements MovePort {
 #mesh:BedMesh|null;#fade:BedMeshFade;#limits:MotionLimits;#validate:(move:Move)=>void;
 #logical:number[];#physical:number[];#queue=new LookAheadQueue();#busy=false;#flushDue=false;
 #split:{splitDeltaZ:number;checkDistance:number};
 constructor(options:BedMeshPortOptions){
  const {physicalPosition,fade}=options;
  if(!Array.isArray(physicalPosition)||physicalPosition.length!==4||!physicalPosition.every(Number.isFinite)||typeof options.validate!=='function'||isAsyncFunction(options.validate))throw new RangeError('Invalid mesh port configuration');
  this.#mesh=options.mesh?.copy()??null;this.#fade=fade;this.#physical=[...physicalPosition];this.#limits={...options.limits,extraAxes:options.limits.extraAxes?[...options.limits.extraAxes]:undefined};this.#validate=options.validate;
  this.#split={splitDeltaZ:options.splitDeltaZ??.025,checkDistance:options.checkDistance??5};
  if(!Number.isFinite(this.#split.splitDeltaZ)||this.#split.splitDeltaZ<.01||!Number.isFinite(this.#split.checkDistance)||this.#split.checkDistance<3)throw new RangeError('Invalid mesh split configuration');
  if(this.#mesh&&fade.enabled){const [low,high]=this.#mesh.range();if(fade.distance<=Math.max(Math.abs(low),Math.abs(high))||fade.distance<=high-fade.target||(fade.target!==0&&(fade.target<low||fade.target>high)))throw new RangeError('Invalid mesh fade range or target');}
  this.#logical=this.#inverse();new Move(this.#limits,this.#physical,this.#physical,1);
 }
 #idle(){if(this.#busy)throw new Error('Mesh motion admission active');}
 #inverse():number[]{const p=[...this.#physical];if(this.#mesh)p[2]=this.#fade.unapply(p[2],this.#mesh.calcZ(p[0],p[1]));return p;}
 position():readonly number[]{this.#idle();const position=this.#inverse();this.#logical=[...position];return position;}
 get plannedPosition():readonly number[]{return [...this.#physical];}
 get pending():number{return this.#queue.length;}
 get flushDue():boolean{return this.#flushDue;}
 move(position:readonly number[],speed:number):void{
  this.#idle();if(!Array.isArray(position)||position.length!==4||!position.every(Number.isFinite)||!Number.isFinite(speed)||speed<=0)throw new RangeError('Invalid mesh motion');
  const target=[...position];this.#busy=true;
  try{
   let endpoints:number[][];
   const factor=this.#mesh?this.#fade.factor(target[2]):0;
   if(this.#mesh&&factor)endpoints=splitBedMeshMove(this.#mesh,this.#logical,target,{...this.#split,factor,fadeOffset:this.#fade.target});
   else {const end=[...target];if(this.#mesh)end[2]+=this.#fade.target;endpoints=[end];}
   if(this.#queue.length+endpoints.length>100000)throw new RangeError('Mesh lookahead budget exceeded');
   let previous=this.#physical;const staged:Move[]=[];
   for(const end of endpoints){const move=new Move(this.#limits,previous,end,speed);if(move.distance){const outcome:unknown=this.#validate(move);if(outcome!==undefined){if(isPromise(outcome))void outcome.catch(()=>{});throw new TypeError('Motion validator must return synchronously without a value');}staged.push(move);}previous=move.endPos;}
   const finalPhysical=[...previous];const due=this.#queue.addBatch(staged);
   this.#physical=finalPhysical;this.#logical=target;this.#flushDue=due||this.#flushDue;
  }finally{this.#busy=false;}
 }
 /** Flush for downstream planning; does not send anything to hardware. */
 flush(lazy=false):Move[]{this.#idle();this.#busy=true;try{const moves=this.#queue.flush(lazy);this.#flushDue=false;return moves;}finally{this.#busy=false;}}
}
