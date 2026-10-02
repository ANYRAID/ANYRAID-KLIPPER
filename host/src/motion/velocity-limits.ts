import {motionLimits,type MotionLimits} from './lookahead.ts';
export interface VelocitySettings {maxVelocity:number;maxAccel:number;squareCornerVelocity:number;minCruiseRatio:number;}
export type VelocityUpdate=Partial<VelocitySettings>;
export class VelocityUpdateUnavailable extends Error {constructor(){super('Motion limits cannot be changed while motion is busy or paused');}}
export function resolveVelocitySettings(settings:VelocitySettings):MotionLimits {
 const s=settings,limits=motionLimits(s.maxVelocity,s.maxAccel,s.squareCornerVelocity,s.minCruiseRatio);
 if(!Number.isFinite(s.maxVelocity**2)||!Number.isFinite(limits.junctionDeviation)||!Number.isFinite(limits.mcrPseudoAccel)||limits.mcrPseudoAccel<=0)throw new RangeError('Motion limit arithmetic overflow');return limits;
}
/** Publish only after synchronous admission succeeds. Previously admitted Move
 * objects keep their own immutable limit generation. */
export class VelocityLimits {
 #state:VelocitySettings;
 constructor(initial:MotionLimits,settings?:Pick<VelocitySettings,'squareCornerVelocity'|'minCruiseRatio'>){
  this.#state={maxVelocity:initial.maxVelocity,maxAccel:initial.maxAccel,...settings??{squareCornerVelocity:Math.sqrt(initial.junctionDeviation*initial.maxAccel/(Math.sqrt(2)-1)),minCruiseRatio:1-initial.mcrPseudoAccel/initial.maxAccel}};
  resolveVelocitySettings(this.#state);
 }
 get state():VelocitySettings{return {...this.#state};}
 get objectStatus(){const s=this.#state;return {max_velocity:s.maxVelocity,max_accel:s.maxAccel,square_corner_velocity:s.squareCornerVelocity,minimum_cruise_ratio:s.minCruiseRatio};}
 update(patch:VelocityUpdate,accept:(limits:MotionLimits)=>void):void {
  const next={...this.#state,...patch},limits=resolveVelocitySettings(next);accept(limits);this.#state=next;
 }
}
