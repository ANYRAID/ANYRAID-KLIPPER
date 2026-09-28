import {LinearKinematics,KinematicError,type LinearConfig,type Axis} from './linear.ts';
import {dualCarriageRange,planCarriageMode,type CarriagePair,type CarriageMode,type CarriageRail} from './dual-carriage.ts';
import {carriageSolvers,dualCarriagePosition,type CarriageTopology} from './dual-carriage-projection.ts';
import type {Move} from '../motion/lookahead.ts';
export interface DualCarriageGeometry extends CarriageTopology {rails:readonly [CarriageRail,CarriageRail];safeDistance:number;}
/** Live admission and active-rail readback. The port commits state only after
 * native rebase succeeds; no method here moves motors or grants homing. */
export class DualCarriageLinearKinematics extends LinearKinematics {
 readonly geometry:DualCarriageGeometry;#carriages:CarriagePair;#range:readonly [number,number]|null=null;#homed:[boolean,boolean]=[false,false];#coupled=false;
 constructor(config:LinearConfig,geometry:DualCarriageGeometry,carriages:CarriagePair){
  super(config);if(config.kind!==geometry.kind)throw new Error('Carriage kinematics mismatch');carriageSolvers(geometry);
  this.geometry=Object.freeze({...geometry,rails:Object.freeze(geometry.rails.map(r=>Object.freeze({...r}))) as unknown as DualCarriageGeometry['rails']});this.#carriages=carriages;this.commitCarriages(carriages);
 }
 get homedCarriages():readonly [boolean,boolean]{return Object.freeze([...this.#homed]) as readonly [boolean,boolean];}
 override markHomed(axes:readonly Axis[]):void{super.markHomed(axes);if(axes.includes(this.geometry.axis))this.#homed[this.primary]=true;}
 override clearHoming(axes:readonly Axis[]):void{super.clearHoming(axes);if(axes.includes(this.geometry.axis))this.#homed=[false,false];}
 get carriages():CarriagePair{return this.#carriages;}
 get primary():0|1{return this.#carriages[0].mode==='PRIMARY'?0:1;}
 get solverModes():LinearKinematics['solverModes']{const modes=[...super.solverModes] as unknown as ['x'|'corexy+'|'corexy-'|'corexz+'|'corexz-','y'|'corexy-','z'|'corexz-'];if(this.geometry.axis===0)modes[0]=carriageSolvers(this.geometry)[this.primary] as typeof modes[0];return modes;}
 /** Homing alone may select a rail before either parked coordinate is known. */
 planHomingPrimary(position:number,index:0|1){return planCarriageMode(this.#carriages,position,index,'PRIMARY',false);}
 planMode(position:number,index:0|1,mode:CarriageMode){
  const plan=planCarriageMode(this.#carriages,position,index,mode,this.#homed.every(Boolean));
  if(plan.carriages.filter(c=>c.mode==='PRIMARY').length!==1)throw new Error('Carriage mode must retain one primary');
  const range=dualCarriageRange(this.geometry.rails,plan.carriages,this.geometry.safeDistance);
  if(!range||plan.position<range[0]||plan.position>range[1])throw new KinematicError('out_of_range');return plan;
 }
 /** Privileged publication after a successful native generation replacement. */
 commitCarriages(carriages:CarriagePair):void{
  if(carriages.filter(c=>c.mode==='PRIMARY').length!==1)throw new Error('Carriage state requires one primary');
  const range=dualCarriageRange(this.geometry.rails,carriages,this.geometry.safeDistance);
  this.#coupled=carriages.some(c=>c.mode==='COPY'||c.mode==='MIRROR');this.#range=range;this.#carriages=Object.freeze(carriages.map(c=>Object.freeze({...c}))) as unknown as CarriagePair;
  const r=this.geometry.rails[this.primary],offset=this.#carriages[this.primary].offset;this.replaceRailRange(this.geometry.axis,[r.minimum-offset,r.maximum-offset]);
  if(this.#homed[this.primary])super.markHomed([this.geometry.axis]);else super.clearHoming([this.geometry.axis]);
 }
 override calcPosition(motors:readonly number[]):number[]{
  if(motors.length!==3||!motors.every(Number.isFinite))throw new RangeError('Invalid active carriage readback');
  const all=[...motors,0];if(this.primary===1)all[3]=motors[this.geometry.axis];
  return dualCarriagePosition(this.geometry,this.#carriages,all);
 }
 override check(move:Move):void{
  super.check(move);if(!move.axesD[this.geometry.axis])return;
  if(this.#coupled&&(!this.#homed[0]||!this.#homed[1]))throw new KinematicError('unhomed');
  const limits=this.#range,p=move.endPos[this.geometry.axis];
  if(!limits||p<limits[0]||p>limits[1])throw new KinematicError('out_of_range');
 }
}
