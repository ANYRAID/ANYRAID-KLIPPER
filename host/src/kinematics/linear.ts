// Cartesian/CoreXY admission and homing geometry from klippy/kinematics/*.py.
// Original Copyright (C) 2016-2021 Kevin O'Connor. GPL-3.0-or-later.
import type {Move} from '../motion/lookahead.ts';
export type Axis=0|1|2;
export type Range=readonly [number,number];
export interface LinearConfig {
  kind:'cartesian'|'corexy';ranges:readonly [Range,Range,Range];
  maxVelocity:number;maxAccel:number;maxZVelocity:number;maxZAccel:number;
}
export class KinematicError extends Error {
  readonly code:'unhomed'|'out_of_range';
  constructor(code:'unhomed'|'out_of_range'){super(code==='unhomed'?'Must home axis first':'Move out of range');this.code=code;}
}
function axis(value:number):asserts value is Axis {if(!Number.isInteger(value)||value<0||value>2)throw new RangeError('Invalid axis');}
function range(value:Range):[number,number] {
  if(value.length!==2||!value.every(Number.isFinite)||value[0]>value[1])throw new RangeError('Invalid axis range');return [...value];
}
/** Geometry/admission only: motor steps and homing completion come from hardware adapters. */
export class LinearKinematics {
  #config:LinearConfig;#ranges:[Range,Range,Range];#limits:([number,number]|null)[]=[null,null,null];
  constructor(config:LinearConfig) {
    if(!['cartesian','corexy'].includes(config.kind)||config.ranges.length!==3
      ||![config.maxVelocity,config.maxAccel,config.maxZVelocity,config.maxZAccel].every(v=>Number.isFinite(v)&&v>0)
      ||config.maxZVelocity>config.maxVelocity||config.maxZAccel>config.maxAccel)throw new RangeError('Invalid linear kinematics configuration');
    this.#ranges=[range(config.ranges[0]),range(config.ranges[1]),range(config.ranges[2])];this.#config={...config,ranges:this.#ranges};
  }
  get status():{homedAxes:string;axisMinimum:number[];axisMaximum:number[]} {
    return {homedAxes:this.#limits.map((v,i)=>v?'xyz'[i]:'').join(''),axisMinimum:this.#ranges.map(r=>r[0]),axisMaximum:this.#ranges.map(r=>r[1])};
  }
  /** Only the completed homing/position-authority path may call this method. */
  markHomed(axes:readonly Axis[]):void {axes.forEach(axis);for(const i of axes)this.#limits[i]=[...this.#ranges[i]];}
  clearHoming(axes:readonly Axis[]):void {axes.forEach(axis);for(const i of axes)this.#limits[i]=null;}
  updateLimits(index:Axis,value:Range):void {axis(index);const next=range(value);if(this.#limits[index])this.#limits[index]=next;}
  calcPosition(steppers:readonly number[]):number[] {
    if(steppers.length!==3||!steppers.every(Number.isFinite))throw new RangeError('Invalid stepper positions');
    const [a,b,z]=steppers,p=this.#config.kind==='corexy'?[.5*(a+b),.5*(a-b),z]:[a,b,z];
    if(!p.every(Number.isFinite))throw new RangeError('Kinematic position overflow');return p;
  }
  homingMove(index:Axis,endstop:number,positiveDirection:boolean):{force:(number|null)[];home:(number|null)[]} {
    axis(index);const [low,high]=this.#ranges[index];
    if(!Number.isFinite(endstop)||endstop<low||endstop>high)throw new RangeError('Invalid endstop position');
    const home:(number|null)[]=[null,null,null,null];home[index]=endstop;const force=[...home];
    force[index]=positiveDirection?endstop-1.5*(endstop-low):endstop+1.5*(high-endstop);
    if(!Number.isFinite(force[index]))throw new RangeError('Homing geometry overflow');return {force,home};
  }
  #checkEndstops(move:Move):void {
    for(let i=0;i<3;i++) {
      if(!move.axesD[i])continue;const limits=this.#limits[i];
      if(!limits)throw new KinematicError('unhomed');
      if(move.endPos[i]<limits[0]||move.endPos[i]>limits[1])throw new KinematicError('out_of_range');
    }
  }
  check(move:Move):void {
    const [x,y]=move.endPos,lx=this.#limits[0],ly=this.#limits[1];
    if(!lx||!ly||x<lx[0]||x>lx[1]||y<ly[0]||y>ly[1])this.#checkEndstops(move);
    if(!move.axesD[2])return;
    this.#checkEndstops(move);
    const ratio=move.distance/Math.abs(move.axesD[2]);
    // An infinite ratio from a subnormal Z component cannot impose a finite cap.
    if(ratio===Infinity)return;
    move.limitSpeed(this.#config.maxZVelocity*ratio,this.#config.maxZAccel*ratio);
  }
}
