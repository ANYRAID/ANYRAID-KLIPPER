import type {Move,Trapezoid} from './lookahead.ts';
const bits=new DataView(new ArrayBuffer(8));
function spacing(value:number):number{value=Math.abs(value);bits.setFloat64(0,value);bits.setBigUint64(0,bits.getBigUint64(0)+1n);return bits.getFloat64(0)-value;}
/** A trapezoid may contain a phase shorter than the absolute clock
 * can represent. One-sided replacement preserves exact endpoints; two-sided
 * plateau folding has an explicit one-ULP / 1e-12 mm endpoint-error ceiling.
 * Never increase acceleration or change the planner's logical timeline. */
export function representableProfile(move:Move,time:number):(Trapezoid&{accel:number})|undefined{
 const p=move.profile!;
 const accelEnd=time+p.accelT,cruiseEnd=accelEnd+p.cruiseT;
 if(!(p.cruiseT>0)||!(p.accelT>0&&accelEnd===time||cruiseEnd===accelEnd||p.decelT>0&&cruiseEnd+p.decelT===cruiseEnd))return;
 // Two real ramps can straddle a plateau whose duration rounds to zero on
 // the absolute clock. Preserve ramp timing, velocities and acceleration.
 // Bound both removed travel and native integrated endpoint error to one
 // coordinate ULP, with a separate 1e-12 mm ceiling for large coordinates.
 // Logical endpoints remain untouched; this is a bounded representation,
 // not a claim of bit-identical intermediate geometry.
 if(cruiseEnd===accelEnd&&p.accelT>0&&p.decelT>0&&accelEnd>time&&cruiseEnd+p.decelT>cruiseEnd){
  let bounded=true;
  for(let i=0;i<move.axesR.length;i++){
   const ratio=move.axesR[i];if(!ratio)continue;
   const bound=Math.min(spacing(move.startPos[i]),spacing(move.endPos[i]),1e-12);
   const middle=move.startPos[i]+ratio*(p.startV+.5*move.accel*p.accelT)*p.accelT;
   const end=middle+ratio*(p.cruiseV-.5*move.accel*p.decelT)*p.decelT;
   // Extrusion trap rows multiply velocity and acceleration before integration.
   const eMiddle=move.startPos[i]+(p.startV*ratio+.5*move.accel*ratio*p.accelT)*p.accelT;
   const eEnd=eMiddle+(p.cruiseV*ratio-.5*move.accel*ratio*p.decelT)*p.decelT;
   if(!Number.isFinite(end)||Math.abs(end-move.endPos[i])>bound||i>=3&&(!Number.isFinite(eEnd)||Math.abs(eEnd-move.endPos[i])>bound)||p.cruiseV*p.cruiseT*Math.abs(ratio)>bound)bounded=false;
  }
  if(bounded)return {...p,cruiseT:0,accel:move.accel};
 }
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
 const velocityRange=Math.abs(p.endV-p.startV),total=p.accelT+p.cruiseT+p.decelT;
 // Shifting a monotone ramp across cruise contributes at most dv * cruise.
 // A different total duration adds a velocity/time bound, including the ramp
 // rescaling term. This is tighter than treating all cruise travel as error.
 const shiftedBound=velocityRange*p.cruiseT+(p.cruiseV+velocityRange)*Math.abs(duration-total);
 const bound=Math.min(p.cruiseV*p.cruiseT,velocityRange*Math.max(duration,total),shiftedBound);
 for(let i=0;i<move.axesR.length;i++){
  const ratio=move.axesR[i];if(!ratio)continue;
  if(i>=3&&move.startPos[i]+(p.startV*ratio+.5*signed*ratio*duration)*duration!==move.endPos[i])continue candidate;
  if(bound*Math.abs(ratio)>Math.min(spacing(move.startPos[i]),spacing(move.endPos[i]))||move.startPos[i]+ratio*distance!==move.endPos[i])continue candidate;
 }
 return {startV:p.startV,cruiseV:Math.max(p.startV,p.endV),endV:p.endV,accelT:accelerating?duration:0,cruiseT:0,decelT:decelerating?duration:0,accel};
 }
 // A sub-clock ramp need not be spread over the whole move. Borrow one
 // representable clock interval from cruise, reducing acceleration. Require
 // unchanged boundary speeds, absolute end time and native XYZ/E endpoints.
 // The velocity curves differ over at most the added ramp duration; their
 // integrated deviation is bounded by velocity range times that duration.
 const oldRamp=accelerating?p.accelT:p.decelT;
 if(oldRamp>0&&(accelerating?accelEnd===time:cruiseEnd+p.decelT===cruiseEnd)){
  const duration=spacing(accelerating?time:cruiseEnd),extra=duration-oldRamp,cruise=p.cruiseT-extra;
  const accel=Math.abs(p.endV-p.startV)/duration,signed=accelerating?accel:-accel;
  const a=accelerating?duration:0,d=decelerating?duration:0,middle=time+a,end=middle+cruise;
  if(extra>0&&cruise>0&&accel>0&&accel<=move.accel&&p.startV+signed*duration===p.endV
   &&(!a||middle>time)&&end>middle&&(!d||end+d>end)&&end+d===cruiseEnd+p.decelT){
   let exact=true;
   for(let i=0;i<move.axesR.length;i++){
    const r=move.axesR[i];if(!r)continue;
    const first=accelerating?p.startV:p.cruiseV;
    let x=move.startPos[i],e=x;
    if(accelerating){x+=r*((first+.5*accel*duration)*duration);e+=(first*r+.5*accel*r*duration)*duration;}
    x+=r*(p.cruiseV*cruise);e+=p.cruiseV*r*cruise;
    if(decelerating){x+=r*((first-.5*accel*duration)*duration);e+=(first*r-.5*accel*r*duration)*duration;}
    const bound=Math.abs(p.endV-p.startV)*extra*Math.abs(r);
    if(x!==move.endPos[i]||i>=3&&e!==move.endPos[i]||bound>Math.min(spacing(move.startPos[i]),spacing(move.endPos[i]),1e-12))exact=false;
   }
   if(exact)return {...p,accelT:a,cruiseT:cruise,decelT:d,accel};
  }
 }

}
