// Delta geometry and admission port from klippy/kinematics/delta.py.
// Copyright (C) 2016-2021 Kevin O'Connor. GPL-3.0-or-later.
import {trilateration,type Vec3} from '../math/mathutil.ts';
import {Move,motionLimits} from '../motion/lookahead.ts';
import type {Axis} from './linear.ts';
import {KinematicError} from './linear.ts';
export interface DeltaConfig {
  radius:number;printRadius:number;arms:Vec3;angles:Vec3;endstops:Vec3;stepDistances:Vec3;
  minimumZ:number;maxVelocity:number;maxAccel:number;maxZVelocity:number;maxZAccel:number;
}
function triple(v:Vec3):Vec3 {if(v.length!==3||!v.every(Number.isFinite))throw new RangeError('Invalid Delta triple');return [...v];}
function map3<T,R>(v:readonly [T,T,T],f:(value:T,index:number)=>R):[R,R,R] {return [f(v[0],0),f(v[1],1),f(v[2],2)];}
export class DeltaKinematics {
  #c:DeltaConfig;#arm2:Vec3;#towers:[Vec3,Vec3,Vec3];#endstops:Vec3;#home:Vec3;
  #maxZ:number;#coneZ:number;#minArm:number;#slow2:number;#verySlow2:number;#maxXY2:number;
  #needHome=true;#cachedXY2=-1;
  constructor(config:DeltaConfig) {
    const c=this.#c={...config,arms:triple(config.arms),angles:triple(config.angles),endstops:triple(config.endstops),stepDistances:triple(config.stepDistances)};
    if(![c.radius,c.printRadius,c.maxVelocity,c.maxAccel,c.maxZVelocity,c.maxZAccel,...c.stepDistances].every(v=>Number.isFinite(v)&&v>0)
      ||!Number.isFinite(c.minimumZ)||c.arms.some(a=>a<=c.radius)||c.maxZVelocity>c.maxVelocity||c.maxZAccel>c.maxAccel)throw new RangeError('Invalid Delta configuration');
    this.#arm2=map3(c.arms,a=>a*a);
    this.#endstops=map3(c.endstops,(e,i)=>e+Math.sqrt(this.#arm2[i]-c.radius*c.radius));
    this.#towers=map3(c.angles,(a):Vec3=>{const radians=a*(Math.PI/180);return [Math.cos(radians)*c.radius,Math.sin(radians)*c.radius,0];});
    this.#home=this.calcPosition(this.#endstops);this.#maxZ=Math.min(...c.endstops);
    this.#coneZ=Math.min(...this.#endstops.map((e,i)=>e-c.arms[i]));this.#minArm=Math.min(...c.arms);
    if(c.minimumZ>this.#maxZ)throw new RangeError('Invalid Delta minimum Z');
    const halfStep=Math.min(...c.stepDistances)*.5;
    const ratioToXY=(ratio:number)=>ratio*Math.sqrt(this.#minArm**2/(ratio**2+1)-halfStep**2)+halfStep-c.radius;
    this.#slow2=ratioToXY(3)**2;this.#verySlow2=ratioToXY(6)**2;
    const maxXY=Math.min(c.printRadius,this.#minArm-c.radius,ratioToXY(12));this.#maxXY2=maxXY**2;
    if(maxXY<=0||![...this.#arm2,...this.#endstops,this.#coneZ,this.#slow2,this.#verySlow2,this.#maxXY2].every(Number.isFinite))throw new RangeError('Invalid Delta build envelope');
  }
  get kind(){return 'delta' as const;}
  setMotionLimits(maxVelocity:number,maxAccel:number):void {
    if(![maxVelocity,maxAccel].every(v=>Number.isFinite(v)&&v>0))throw new RangeError('Invalid dynamic motion limits');
    this.#c={...this.#c,maxVelocity,maxAccel};this.#cachedXY2=-1;
  }
  get status(){const r=Math.sqrt(this.#maxXY2);return {homedAxes:this.#needHome?'':'xyz',axisMinimum:[-r,-r,this.#c.minimumZ],axisMaximum:[r,r,this.#maxZ],coneStartZ:this.#coneZ};}
  /** Same tower coordinates used by admission and the native C iterators. */
  get solverGeometry(){return Object.freeze(this.#towers.map((tower,i)=>Object.freeze({kind:'delta' as const,armLength:this.#c.arms[i],towerX:tower[0],towerY:tower[1]})));}
  get homePosition():Vec3{return [...this.#home];}
  get thresholds(){return {slowXY2:this.#slow2,verySlowXY2:this.#verySlow2,maxXY2:this.#maxXY2,cachedXY2:this.#cachedXY2};}
  /** Reset after any physical position change; only xyz confirms all-tower homing. */
  resetPosition(homingAxes=''):void {if(!/^[xyz]*$/.test(homingAxes))throw new RangeError('Invalid homing axes');this.#cachedXY2=-1;if(homingAxes==='xyz')this.#needHome=false;}
  clearHoming(axes:readonly Axis[]=[0,1,2]):void {if(axes.some(a=>!Number.isInteger(a)||a<0||a>2))throw new RangeError('Invalid homing axes');if(axes.length){this.#needHome=true;this.#cachedXY2=-1;}}
  homingMove():{force:Vec3;home:Vec3} {const force:Vec3=[this.#home[0],this.#home[1],-1.5*Math.sqrt(Math.max(...this.#arm2)-this.#maxXY2)];return {force,home:this.homePosition};}
  /** All towers seek together toward the configured home XY. Recovery may
   * start off-center after independently timed stops. Never extrude here. */
  planHomingAxisMove(start:readonly number[],end:readonly number[],speed:number,index:Axis):Move {
    if(index!==2||start.length<4||start.length!==end.length||!start.every(Number.isFinite)||!end.every(Number.isFinite)||end[0]!==this.#home[0]||end[1]!==this.#home[1]||end[2]>this.#home[2]||end[2]<this.homingMove().force[2]||end.slice(3).some((v,i)=>v!==start[i+3]))throw new RangeError('Invalid Delta homing trajectory');
    this.stablePosition([start[0],start[1],start[2]]);this.stablePosition([end[0],end[1],end[2]]);
    const c=this.#c,move=new Move(motionLimits(c.maxVelocity,c.maxAccel),start,end,speed);
    if(!move.isKinematic||!move.axesD[2])throw new RangeError('Delta homing must move Z');
    const ratio=move.distance/Math.abs(move.axesD[2]);if(ratio!==Infinity)move.limitSpeed(c.maxZVelocity*ratio,c.maxZAccel*ratio);
    return move;
  }
  calcPosition(actuators:Vec3):Vec3 {
    triple(actuators);
    return trilateration(map3(this.#towers,(t,i):Vec3=>[t[0],t[1],actuators[i]]),this.#arm2);
  }
  stablePosition(coord:Vec3):Vec3 {
    triple(coord);
    const result=map3(this.#towers,(t,i)=>{
      const actuator=Math.sqrt(this.#arm2[i]-(t[0]-coord[0])**2-(t[1]-coord[1])**2)+coord[2];
      return (this.#endstops[i]-actuator)/this.#c.stepDistances[i];
    });
    if(!result.every(Number.isFinite))throw new RangeError('Unreachable Delta coordinate');return result;
  }
  positionFromStable(stable:Vec3):Vec3 {triple(stable);return this.calcPosition(map3(stable,(v,i)=>this.#endstops[i]-v*this.#c.stepDistances[i]));}
  check(move:Move):void {
    const [x,y,z]=move.endPos,xy2=x*x+y*y;
    if(xy2<=this.#cachedXY2&&!move.axesD[2])return;
    if(this.#needHome)throw new KinematicError('unhomed');
    let limit=this.#maxXY2;
    if(z>this.#coneZ) {
      const above=z-this.#coneZ,radicand=this.#minArm**2-(this.#minArm-above)**2;
      if(radicand<0)throw new KinematicError('out_of_range');
      const radius=this.#c.radius-Math.sqrt(radicand);limit=Math.min(limit,radius*radius);
    }
    if(xy2>limit||z>this.#maxZ||z<this.#c.minimumZ) {
      if(x!==this.#home[0]||y!==this.#home[1]||z<this.#c.minimumZ||z>this.#home[2])throw new KinematicError('out_of_range');
      limit=-1;
    }
    if(move.axesD[2]) {const ratio=move.distance/Math.abs(move.axesD[2]);if(ratio!==Infinity)move.limitSpeed(this.#c.maxZVelocity*ratio,this.#c.maxZAccel*ratio);limit=-1;}
    const extreme=Math.max(xy2,move.startPos[0]**2+move.startPos[1]**2);
    if(extreme>this.#slow2) {const factor=extreme>this.#verySlow2?.25:.5;move.limitSpeed(this.#c.maxVelocity*factor,this.#c.maxAccel*factor);limit=-1;}
    this.#cachedXY2=Math.min(limit,this.#slow2);
  }
}
