import {Move,LookAheadQueue,type MotionLimits} from './lookahead.ts';
/** Stationary native trajectory segment. Separate from discarded zero moves. */
export function dwellMove(limits:MotionLimits,position:readonly number[],seconds:number):Move{
 if(!Number.isFinite(seconds)||seconds<=0||seconds>3600)throw new RangeError('Invalid dwell duration');
 const move=Object.assign(new Move({...limits,extraAxes:limits.extraAxes?[...limits.extraAxes]:undefined},position,position,limits.maxVelocity),{dwellSeconds:seconds});move.minMoveT=seconds;
 move.profile={startV:0,cruiseV:0,endV:0,accelT:0,cruiseT:seconds,decelT:0};return move;
}
export function validateDwell(move:Move):void{
 const p=move.profile,d=move.dwellSeconds;if(!(move instanceof Move)||d===undefined||!Number.isFinite(d)||d<=0||d>3600||!p||p.startV!==0||p.cruiseV!==0||p.endV!==0||p.accelT!==0||p.decelT!==0||p.cruiseT!==d||move.distance!==0||move.isKinematic||move.startPos.length<4||move.endPos.length!==move.startPos.length||move.axesD.length!==move.startPos.length||move.axesR.length!==move.startPos.length||!move.startPos.every(Number.isFinite)||move.endPos.some((value,i)=>value!==move.startPos[i])||move.axesD.some(value=>value!==0)||move.axesR.some(value=>value!==0))throw new RangeError('Invalid stationary dwell');
}
/** Replan retained movement from rest without losing stationary time. */
export function replanWithDwells(moves:readonly Move[]):Move[]{
 if(!Array.isArray(moves)||moves.length>100000)throw new RangeError('Invalid retained motion batch');
 const seen=new Set<Move>();for(const move of moves){if(!(move instanceof Move)||seen.has(move))throw new RangeError('Duplicate or invalid retained move');seen.add(move);if(move.dwellSeconds!==undefined)validateDwell(move);}
 const queue=new LookAheadQueue(),result:Move[]=[],flush=()=>{for(const planned of queue.flush())result.push(planned);};
 for(const move of moves){if(move.dwellSeconds===undefined)queue.add(move);else{flush();result.push(move);}}flush();return result;
}
