// Extrusion admission and junction math from klippy/kinematics/extruder.py.
// GPL-3.0-or-later; original Copyright Kevin O'Connor.
import type {Move} from './lookahead.ts';
export interface ExtrusionLimits {
  nozzleDiameter:number;filamentDiameter:number;maxCrossSection:number;
  maxVelocity:number;maxAccel:number;maxDistance:number;instantCornerVelocity:number;
}
export class ExtrusionGuard {
  readonly limits:Readonly<ExtrusionLimits>;
  readonly filamentArea:number;
  readonly maxRatio:number;
  constructor(limits:ExtrusionLimits) {
    if(![limits.nozzleDiameter,limits.filamentDiameter,limits.maxCrossSection,limits.maxVelocity,limits.maxAccel].every(v=>Number.isFinite(v)&&v>0)
      ||!Number.isFinite(limits.maxDistance)||limits.maxDistance<0||!Number.isFinite(limits.instantCornerVelocity)||limits.instantCornerVelocity<0
      ||limits.filamentDiameter<limits.nozzleDiameter) throw new RangeError('Invalid extrusion limits');
    this.limits=Object.freeze({...limits});this.filamentArea=Math.PI*(limits.filamentDiameter*.5)**2;
    this.maxRatio=limits.maxCrossSection/this.filamentArea;
    if(!Number.isFinite(this.filamentArea)||!Number.isFinite(this.maxRatio)||this.maxRatio<=0) throw new RangeError('Extrusion limit overflow');
  }
  check(move:Move,index:number,canExtrude:boolean):void {
    this.#axis(move,index);
    if(!move.axesD[index]) return;
    // Evaluate this live for every admission; never cache heater permission in a macro.
    if(!canExtrude) throw new Error('Extrude below minimum temperature');
    const ratio=move.axesR[index],distance=move.axesD[index];
    if((!move.axesD[0]&&!move.axesD[1])||ratio<0) {
      if(Math.abs(distance)>this.limits.maxDistance) throw new Error('Extrude-only move too long');
      const inverse=1/Math.abs(ratio);
      move.limitSpeed(this.limits.maxVelocity*inverse,this.limits.maxAccel*inverse);
    } else if(ratio>this.maxRatio && distance>this.limits.nozzleDiameter*this.maxRatio) {
      throw new Error('Move exceeds maximum extrusion');
    }
  }
  junction(previous:Move,current:Move,index:number):number {
    this.#axis(previous,index);this.#axis(current,index);
    const difference=current.axesR[index]-previous.axesR[index];
    return difference ? (this.limits.instantCornerVelocity/Math.abs(difference))**2 : current.maxCruiseV2;
  }
  #axis(move:Move,index:number):void {
    if(!Number.isInteger(index)||index<3||index>=move.axesD.length) throw new RangeError('Invalid extrusion axis');
  }
}
