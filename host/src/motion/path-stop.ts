import {Move} from './lookahead.ts';
import {copyEndMarkers,validateEndMarkers} from './boundary-markers.ts';

export interface PathStop {
 /** Host path coordinates, not measured or reconstructed MCU positions. */
 anchor:readonly number[];
 position:readonly number[];
 velocity:number;
 brake:Move[];
 /** Unplanned geometry: re-admit and run lookahead from rest before resuming. */
 remainder:Move[];
}
const close=(a:number,b:number)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=128*Number.EPSILON*Math.max(1,Math.abs(a),Math.abs(b));
function copy(m:Move,start:readonly number[]=m.startPos,end:readonly number[]=m.endPos,distance=m.distance,endsAtBoundary=true):Move {
 // Preserve an admitted segment's direction and limits even for sub-nanometre
 // fragments: the ordinary Move constructor intentionally treats those as E-only.
 return Object.assign(Object.create(Move.prototype),m,{endMarkers:endsAtBoundary?copyEndMarkers(m.endMarkers):undefined,limits:{...m.limits,extraAxes:m.limits.extraAxes?[...m.limits.extraAxes]:undefined},startPos:[...start],endPos:[...end],axesD:end.map((v,i)=>v-start[i]),axesR:[...m.axesR],distance,minMoveT:distance/Math.sqrt(m.maxCruiseV2),deltaV2:2*distance*m.accel,mcrDeltaV2:Math.min(2*distance*m.limits.mcrPseudoAccel,2*distance*m.accel),maxStartV2:0,maxMcrStartV2:0,profile:undefined});
}
function point(m:Move,distance:number):number[]{
 if(distance===0)return [...m.startPos];if(distance===m.distance)return [...m.endPos];
 return m.startPos.map((v,i)=>v+m.axesR[i]*distance);
}
function suffix(moves:readonly Move[],index:number,first?:Move):Move[]{const result=first?[first]:[];for(let i=index;i<moves.length;i++)result.push(copy(moves[i]));return result;}
export function validateStopPath(moves:readonly Move[]):void {
 if(!Array.isArray(moves)||moves.length>100000)throw new RangeError('Invalid stop path');
 let previous:Move|undefined;
 for(const m of moves){
  validateEndMarkers(m.endMarkers);
  const p=m.profile;
  if(!m.limits||![m.limits.maxVelocity,m.limits.maxAccel,m.limits.mcrPseudoAccel,m.limits.junctionDeviation].every(Number.isFinite)||m.limits.maxVelocity<=0||m.limits.maxAccel<=0||m.limits.mcrPseudoAccel<=0||m.limits.mcrPseudoAccel>m.limits.maxAccel||m.limits.junctionDeviation<0)throw new RangeError('Invalid stop path limits');
  if(!(m instanceof Move)||!p||m.startPos.length<4||m.endPos.length!==m.startPos.length||m.axesR.length!==m.startPos.length||![...m.startPos,...m.endPos,...m.axesR,m.distance,m.accel,m.maxCruiseV2].every(Number.isFinite)||m.distance<=0||m.accel<=0||m.maxCruiseV2<=0||![p.startV,p.cruiseV,p.endV,p.accelT,p.cruiseT,p.decelT].every(v=>Number.isFinite(v)&&v>=0)||p.cruiseV<=0||p.cruiseV<p.startV||p.cruiseV<p.endV||!close(p.cruiseV-p.startV,m.accel*p.accelT)||!close(p.cruiseV-p.endV,m.accel*p.decelT)||!close(m.distance,(p.startV+p.cruiseV)*p.accelT/2+p.cruiseV*p.cruiseT+(p.cruiseV+p.endV)*p.decelT/2)||p.cruiseV**2>m.maxCruiseV2&&!close(p.cruiseV**2,m.maxCruiseV2))throw new RangeError('Invalid planned stop segment');
  if(m.endPos.some((v,i)=>!close(v-m.startPos[i],m.axesR[i]*m.distance)))throw new RangeError('Inconsistent stop geometry');
  if(previous&&(previous.endPos.length!==m.startPos.length||m.startPos.some((v,i)=>v!==previous!.endPos[i])||!close(previous.profile!.endV,p.startV)))throw new RangeError('Discontinuous stop path');
  previous=m;
 }
}

/** Maximum admitted scalar deceleration along an already planned path.
 * Pure geometry only: does not edit queues, cancel pulses or establish homing.
 * A runtime must choose an anchor beyond generated/filter dependencies, own
 * the full braking suffix, and revalidate heater/kinematic limits on resume. */
export function planPathStop(moves:readonly Move[],elapsed:number):PathStop {
 validateStopPath(moves);if(!moves.length||!Number.isFinite(elapsed)||elapsed<0)throw new RangeError('Invalid stop anchor');
 let index=0,time=elapsed;
 while(index<moves.length){const p=moves[index].profile!,duration=p.accelT+p.cruiseT+p.decelT;if(time<duration)break;time-=duration;index++;}
 if(index===moves.length){if(time!==0||moves.at(-1)!.profile!.endV!==0)throw new RangeError('Stop anchor has no braking coverage');const position=[...moves.at(-1)!.endPos];return {anchor:[...position],position,velocity:0,brake:[],remainder:[]};}
 const first=moves[index],p=first.profile!;
 let distance:number,velocity:number;
 if(time<p.accelT){velocity=p.startV+first.accel*time;distance=(p.startV+velocity)*time/2;}
 else if(time<p.accelT+p.cruiseT){velocity=p.cruiseV;distance=(p.startV+p.cruiseV)*p.accelT/2+p.cruiseV*(time-p.accelT);}
 else {const left=p.decelT-(time-p.accelT-p.cruiseT);velocity=p.endV+first.accel*left;distance=first.distance-(velocity+p.endV)*left/2;}
 if(distance<0&&close(distance,0))distance=0;if(distance>first.distance&&close(distance,first.distance))distance=first.distance;
 if(distance<0||distance>first.distance||!Number.isFinite(velocity))throw new RangeError('Unrepresentable stop anchor');
 const anchor=point(first,distance),initialVelocity=velocity,brake:Move[]=[];
 let position=[...anchor];
 for(;index<moves.length;index++,distance=0){
  const m=moves[index],available=m.distance-distance;
  if(available===0)continue;
  if(velocity===0)return {anchor,position,velocity:initialVelocity,brake,remainder:suffix(moves,index+1,copy(m,position,m.endPos,available))};
  const needed=velocity**2/(2*m.accel);if(!Number.isFinite(needed)||needed<=0)throw new RangeError('Unrepresentable stopping distance');
  // Sampling a deceleration subtracts its tiny tail from a longer segment.
  // Recognize an endpoint only within the arithmetic error of that subtraction,
  // never with a physical-distance epsilon that could erase real motion.
  const atEnd=Math.abs(needed-available)<=32*Number.EPSILON*Math.max(m.distance,needed,available);
  const travel=atEnd?available:Math.min(needed,available),end=travel===available?[...m.endPos]:point(m,distance+travel),endVelocity=needed<=available||atEnd?0:Math.sqrt(Math.max(0,velocity**2-2*m.accel*travel));
  if(end.every((v,i)=>v===position[i]))throw new RangeError('Stop displacement below coordinate resolution');
  const segment=copy(m,position,end,travel,travel===available);
  if(velocity**2>m.maxCruiseV2&&!close(velocity**2,m.maxCruiseV2))throw new RangeError(`Stop speed exceeds admitted segment limit: ${velocity**2} > ${m.maxCruiseV2}`);
  // Avoid squaring/square-root round trips at junctions. The accepted source
  // profile may already be one ULP above the squared velocity limit.
  segment.profile={startV:velocity,cruiseV:velocity,endV:endVelocity,accelT:0,cruiseT:0,decelT:2*travel/(velocity+endVelocity)};
  brake.push(segment);position=end;velocity=endVelocity;
  if(velocity===0)return {anchor,position,velocity:initialVelocity,brake,remainder:suffix(moves,index+1,travel<available?copy(m,position,m.endPos,available-travel):undefined)};
 }
 throw new RangeError('Stop path has insufficient braking coverage');
}
