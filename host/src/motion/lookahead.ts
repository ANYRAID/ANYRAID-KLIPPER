// Port of Move and LookAheadQueue from klippy/toolhead.py.
// Copyright (C) 2016-2025 Kevin O'Connor. GPL-3.0-or-later.
export interface MotionLimits {
  maxVelocity:number;
  maxAccel:number;
  junctionDeviation:number;
  mcrPseudoAccel:number;
  extraAxes?:readonly ((previous:Move,current:Move,index:number)=>number)[];
}
export interface Trapezoid {
  startV:number;cruiseV:number;endV:number;
  accelT:number;cruiseT:number;decelT:number;
}
function positive(value:number):boolean {return Number.isFinite(value)&&value>0;}
// CPython 3.12+ sum() compensates rounding. Near-straight junctions amplify
// even a one-ulp norm difference, so retain its high/low accumulation here.
function spatialDistance(axes:readonly number[]):number {
  let high=0,low=0;
  for(let i=0;i<3;i++) {
    const value=axes[i]*axes[i],total=high+value;
    low+=Math.abs(high)>=Math.abs(value)?(high-total)+value:(value-total)+high;
    high=total;
  }
  return Math.sqrt(high+low);
}
export function motionLimits(maxVelocity:number,maxAccel:number,squareCornerVelocity=5,minCruiseRatio=.5):MotionLimits {
  if(!positive(maxVelocity)||!positive(maxAccel)||!Number.isFinite(squareCornerVelocity)||squareCornerVelocity<0
    ||!Number.isFinite(minCruiseRatio)||minCruiseRatio<0||minCruiseRatio>=1) throw new RangeError('Invalid motion limits');
  return {maxVelocity,maxAccel,junctionDeviation:squareCornerVelocity**2*(Math.sqrt(2)-1)/maxAccel,mcrPseudoAccel:maxAccel*(1-minCruiseRatio)};
}
/** Planner primitive. Kinematic and extrusion safety checks must precede queue admission. */
export class Move {
  readonly limits:MotionLimits;
  readonly startPos:number[];
  readonly endPos:number[];
  readonly axesD:number[];
  readonly axesR:number[];
  readonly distance:number;
  readonly isKinematic:boolean;
  readonly junctionDeviation:number;
  accel:number;
  minMoveT:number;
  maxStartV2=0;
  maxCruiseV2:number;
  deltaV2:number;
  nextJunctionV2=999999999.9;
  maxMcrStartV2=0;
  mcrDeltaV2:number;
  profile:Trapezoid|undefined;
  constructor(limits:MotionLimits,start:readonly number[],end:readonly number[],speed:number) {
    if(start.length<4||start.length!==end.length||!start.every(Number.isFinite)||!end.every(Number.isFinite)
      ||!positive(speed)||!positive(limits.maxVelocity)||!positive(limits.maxAccel)
      ||!Number.isFinite(limits.junctionDeviation)||limits.junctionDeviation<0
      ||!positive(limits.mcrPseudoAccel)||limits.mcrPseudoAccel>limits.maxAccel) throw new RangeError('Invalid move');
    this.limits=limits;this.startPos=[...start];this.endPos=[...end];
    this.accel=limits.maxAccel;this.junctionDeviation=limits.junctionDeviation;
    let velocity=Math.min(speed,limits.maxVelocity);
    this.axesD=end.map((v,i)=>v-start[i]);
    let distance=spatialDistance(this.axesD);
    if(!Number.isFinite(distance)) throw new RangeError('Move distance overflow');
    this.isKinematic=distance>=1e-9;
    if(!this.isKinematic) {
      for(let i=0;i<3;i++) {this.endPos[i]=start[i];this.axesD[i]=0;}
      distance=0;for(let i=3;i<this.axesD.length;i++) distance=Math.max(distance,Math.abs(this.axesD[i]));
      this.accel=99999999.9;velocity=speed;
    }
    this.distance=distance;
    const inverse=distance?1/distance:0;
    this.axesR=this.axesD.map(d=>d*inverse);
    this.minMoveT=distance/velocity;this.maxCruiseV2=velocity**2;
    this.deltaV2=2*distance*this.accel;this.mcrDeltaV2=2*distance*limits.mcrPseudoAccel;
    if(![distance,this.minMoveT,this.maxCruiseV2,this.deltaV2,this.mcrDeltaV2,...this.axesR].every(Number.isFinite)) throw new RangeError('Move calculation overflow');
  }
  limitSpeed(speed:number,accel:number):void {
    if(!positive(speed)||!positive(accel)||!Number.isFinite(speed**2)) throw new RangeError('Invalid move speed limit');
    if(speed**2<this.maxCruiseV2) {this.maxCruiseV2=speed**2;this.minMoveT=this.distance/speed;}
    this.accel=Math.min(this.accel,accel);this.deltaV2=2*this.distance*this.accel;
    this.mcrDeltaV2=Math.min(this.mcrDeltaV2,this.deltaV2);
  }
  limitNextJunctionSpeed(speed:number):void {
    if(!Number.isFinite(speed)||speed<0||!Number.isFinite(speed**2)) throw new RangeError('Invalid junction limit');
    this.nextJunctionV2=Math.min(this.nextJunctionV2,speed**2);
  }
  calcJunction(previous:Move):void {
    if(!this.isKinematic||!previous.isKinematic) return;
    let max=Math.min(this.maxCruiseV2,previous.maxCruiseV2,previous.nextJunctionV2,previous.maxStartV2+previous.deltaV2);
    for(let i=0;i<(this.limits.extraAxes?.length??0);i++) {
      const limit=this.limits.extraAxes![i](previous,this,i+3);
      if(Number.isNaN(limit)||limit<0) throw new RangeError('Invalid extra-axis junction limit');
      max=Math.min(max,limit);
    }
    const a=this.axesR,b=previous.axesR;
    const cosine=-(a[0]*b[0]+a[1]*b[1]+a[2]*b[2]);
    const sineHalf=Math.sqrt(Math.max(.5*(1-cosine),0)),cosineHalf=Math.sqrt(Math.max(.5*(1+cosine),0));
    const remaining=1-sineHalf;
    if(remaining>0&&cosineHalf>0) {
      const radius=sineHalf/remaining,quarterTangent=.25*sineHalf/cosineHalf;
      max=Math.min(max,radius*this.junctionDeviation*this.accel,radius*previous.junctionDeviation*previous.accel,
        this.deltaV2*quarterTangent,previous.deltaV2*quarterTangent);
    }
    this.maxStartV2=max;
    this.maxMcrStartV2=Math.min(max,previous.maxMcrStartV2+previous.mcrDeltaV2);
  }
  setJunction(startV2:number,cruiseV2:number,endV2:number):void {
    if(![startV2,cruiseV2,endV2].every(Number.isFinite)||startV2<0||endV2<0||cruiseV2<=0
      ||cruiseV2<startV2||cruiseV2<endV2||cruiseV2>this.maxCruiseV2) throw new RangeError('Invalid planned junction');
    const halfInverse=.5/this.accel;
    const accelD=(cruiseV2-startV2)*halfInverse,decelD=(cruiseV2-endV2)*halfInverse;
    const cruiseD=this.distance-accelD-decelD;
    if(cruiseD< -16*Number.EPSILON*Math.max(1,this.distance)) throw new RangeError('Trapezoid exceeds move length');
    const startV=Math.sqrt(startV2),cruiseV=Math.sqrt(cruiseV2),endV=Math.sqrt(endV2);
    const accelT=accelD/((startV+cruiseV)*.5),cruiseT=Math.max(0,cruiseD)/cruiseV,decelT=decelD/((endV+cruiseV)*.5);
    if(![accelT,cruiseT,decelT].every(Number.isFinite)) throw new RangeError('Nonfinite move duration');
    this.profile={startV,cruiseV,endV,accelT,cruiseT,decelT};
  }
}
export class LookAheadQueue {
  #queue:Move[]=[];
  #junctionFlush=.150;
  get length():number {return this.#queue.length;}
  get last():Move|undefined {return this.#queue.at(-1);}
  reset():void {this.#queue=[];this.#junctionFlush=.150;}
  setFlushTime(time:number):void {
    if(!positive(time)) throw new RangeError('Invalid lookahead flush time');this.#junctionFlush=time;
  }
  add(move:Move):boolean {
    if(!move.distance) return false;
    if(this.#queue.length) move.calcJunction(this.#queue[this.#queue.length-1]);
    this.#queue.push(move);
    if(this.#queue.length===1) return false;
    this.#junctionFlush-=move.minMoveT;
    return this.#junctionFlush<=0;
  }
  flush(lazy=false):Move[] {
    this.#junctionFlush=.150;
    let updateFlush=lazy,flushCount=this.#queue.length;
    const junctions:{move:Move;start:number;cruise:number|null;end:number}[]=new Array(flushCount);
    let nextStart=0,nextMcrStart=0,peakCruise=0,pending=0;
    for(let i=flushCount-1;i>=0;i--) {
      const move=this.#queue[i],reachableStart=nextStart+move.deltaV2,start=Math.min(move.maxStartV2,reachableStart);
      let cruise:number|null=null;pending++;
      const reachableMcr=nextMcrStart+move.mcrDeltaV2,mcrStart=Math.min(move.maxMcrStartV2,reachableMcr);
      if(mcrStart<reachableMcr) {
        if(mcrStart+move.mcrDeltaV2>nextMcrStart||pending>1) {
          if(updateFlush&&peakCruise) {flushCount=i+pending;updateFlush=false;}
          peakCruise=(mcrStart+reachableMcr)*.5;
        }
        cruise=Math.min((start+reachableStart)*.5,move.maxCruiseV2,peakCruise);pending=0;
      }
      junctions[i]={move,start,cruise,end:nextStart};nextStart=start;nextMcrStart=mcrStart;
    }
    if(updateFlush||!flushCount) return [];
    let previousCruise=0;
    for(let i=0;i<flushCount;i++) {
      const {move,start,end}=junctions[i];
      const cruise=junctions[i].cruise??Math.min(previousCruise,start);
      move.setJunction(Math.min(start,cruise),cruise,Math.min(end,cruise));previousCruise=cruise;
    }
    return this.#queue.splice(0,flushCount);
  }
}
