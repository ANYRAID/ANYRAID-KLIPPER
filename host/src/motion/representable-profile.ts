import type {Move,Trapezoid} from './lookahead.ts';
const bits=new DataView(new ArrayBuffer(8));
function spacing(value:number):number{value=Math.abs(value);bits.setFloat64(0,value);bits.setBigUint64(0,bits.getBigUint64(0)+1n);return bits.getFloat64(0)-value;}
/** A one-sided trapezoid may contain a phase shorter than the absolute clock
 * can represent. Replace it only with an endpoint-exact constant acceleration,
 * bounded by one coordinate ULP and the original acceleration limit. Otherwise
 * leave it to native validation. Never change the planner's logical timeline. */
export function representableProfile(move:Move,time:number):(Trapezoid&{accel:number})|undefined{
 const p=move.profile!;
 const accelEnd=time+p.accelT,cruiseEnd=accelEnd+p.cruiseT;
 if(!(p.cruiseT>0)||!(p.accelT>0&&accelEnd===time||cruiseEnd===accelEnd||p.decelT>0&&cruiseEnd+p.decelT===cruiseEnd))return;
 const accelerating=p.decelT===0&&p.startV<p.endV&&p.cruiseV===p.endV;
 const decelerating=p.accelT===0&&p.startV>p.endV&&p.cruiseV===p.startV;
 if(!accelerating&&!decelerating)return;
 // Geometry-derived duration may round the absolute end clock upward. The
 // existing non-cruise duration is another candidate, under identical exact
 // endpoint, speed, acceleration and deviation checks (never an epsilon clamp).
 const geometric=move.distance/((p.startV+p.endV)*.5),ramp=p.accelT+p.decelT;
 // End-clock rounding and coordinate rounding have distinct plateaus. Their
 // overlap can lie between the two endpoint candidates (not at either one).
 // The midpoint is only another candidate; all exact invariants still apply.
 candidate:for(const duration of [geometric,ramp,ramp+(geometric-ramp)*.5]){
 const accel=Math.abs(p.endV-p.startV)/duration;
 if(!(duration>0)||!(accel>0)||accel>move.accel||time+duration!==((time+p.accelT)+p.cruiseT)+p.decelT)continue;
 const signed=accelerating?accel:-accel,distance=(p.startV+.5*signed*duration)*duration;
 if(p.startV+signed*duration!==p.endV)continue;
 // The largest deviation between a cruise+one-sided ramp and its chord-ramp
 // is bounded by cruise distance or velocity range times duration. Require
 // that bound within one representable
 // coordinate increment, and require the actual final coordinate to be exact.
 const bound=Math.min(p.cruiseV*p.cruiseT,Math.abs(p.endV-p.startV)*Math.max(duration,p.accelT+p.cruiseT+p.decelT));
 for(let i=0;i<move.axesR.length;i++){
  const ratio=move.axesR[i];if(!ratio)continue;
  if(i>=3&&move.startPos[i]+(p.startV*ratio+.5*signed*ratio*duration)*duration!==move.endPos[i])continue candidate;
  if(bound*Math.abs(ratio)>Math.min(spacing(move.startPos[i]),spacing(move.endPos[i]))||move.startPos[i]+ratio*distance!==move.endPos[i])continue candidate;
 }
 return {startV:p.startV,cruiseV:Math.max(p.startV,p.endV),endV:p.endV,accelT:accelerating?duration:0,cruiseT:0,decelT:decelerating?duration:0,accel};
 }
}
