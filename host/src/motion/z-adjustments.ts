// Independent Z segment ordering from klippy/extras/z_tilt.py; GPL-3.0-or-later.
export interface ZMotorAdjustment {id:string;adjustment:number;}
/** Pure mechanical plan. The limit bounds actual relative motor travel, not
 * only the largest positive correction about the fitted mean. */
export function planZAdjustments(input:readonly ZMotorAdjustment[],currentZ:number,maximumTravel:number){
 if(input.length<2||input.length>16||input.some(m=>!m.id||!Number.isFinite(m.adjustment))||new Set(input.map(m=>m.id)).size!==input.length||!Number.isFinite(currentZ)||!Number.isFinite(maximumTravel)||maximumTravel<=0)throw new RangeError('Invalid independent Z adjustment inputs');
 const adjustments=input.map(m=>({...m})),order=adjustments.map(m=>({...m,offset:-m.adjustment})).sort((a,b)=>a.offset-b.offset);
 const spread=order.at(-1)!.offset-order[0].offset;
 if(!Number.isFinite(spread)||spread>maximumTravel)throw new RangeError('Z adjustment exceeds travel limit');
 const segments:{motors:readonly string[];targetZ:number;distance:number}[]=[];let previous=currentZ;
 for(let i=0;i<order.length-1;i++){
  const targetZ=currentZ+(order[i+1].offset-order[0].offset),distance=targetZ-previous;
  if(!Number.isFinite(targetZ)||!Number.isFinite(distance)||distance<0||(order[i+1].offset>order[i].offset&&distance===0)||(order[i+1].offset===order[i].offset&&distance!==0))throw new RangeError('Z adjustment motion is not representable');
  segments.push(Object.freeze({motors:Object.freeze(order.slice(0,i+1).map(m=>m.id)),targetZ,distance}));previous=targetZ;
 }
 if(previous-currentZ>maximumTravel)throw new RangeError('Z represented motion exceeds travel limit');
 const finalZ=previous+order[0].offset;if(!Number.isFinite(finalZ))throw new RangeError('Z final coordinate overflow');
 return Object.freeze({adjustments:Object.freeze(adjustments.map(m=>Object.freeze(m))),segments:Object.freeze(segments),finalZ,maximumMotorTravel:spread});
}
