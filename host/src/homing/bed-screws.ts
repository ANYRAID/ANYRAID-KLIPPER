// Manual bed screw workflow from klippy/extras/bed_screws.py. GPL-3.0-or-later.
export interface BedScrewPoint {position:readonly [number,number];name:string;}
export interface BedScrewsPlan {coarse:readonly BedScrewPoint[];fine:readonly BedScrewPoint[];horizontalHeight:number;contactHeight:number;travelSpeed:number;liftSpeed:number;}
export interface BedScrewsState {phase:'idle'|'adjust'|'fine';current:number;accepted:number;}
export const initialBedScrewsState=():BedScrewsState=>({phase:'idle',current:0,accepted:0});
export function validateBedScrewsPlan(plan:BedScrewsPlan):void{
 if(plan.coarse.length<3||plan.coarse.length>99||plan.fine.length>plan.coarse.length||![plan.horizontalHeight,plan.contactHeight,plan.travelSpeed,plan.liftSpeed].every(Number.isFinite)||plan.horizontalHeight<=plan.contactHeight||plan.travelSpeed<=0||plan.liftSpeed<=0||[...plan.coarse,...plan.fine].some(p=>p.position.length!==2||!p.position.every(Number.isFinite)||!p.name.trim()||p.name.length>128||/[\x00-\x1f\x7f]/.test(p.name)))throw new RangeError('Invalid bed screw plan');
}
/** Computes a transition without mutating prior state. Owner publishes it only
 * after all movements settle; failures must stop hardware and invalidate session. */
export function planBedScrews(plan:BedScrewsPlan,state:BedScrewsState,action:'start'|'accept'|'adjusted',position:readonly number[]){
 validateBedScrewsPlan(plan);
 if(position.length!==4||!position.every(Number.isFinite)||!['idle','adjust','fine'].includes(state.phase)||!Number.isSafeInteger(state.current)||!Number.isSafeInteger(state.accepted)||state.current<0||state.accepted<0||state.accepted>=plan.coarse.length)throw new RangeError('Invalid bed screw state');
 let next:BedScrewsState;
 if(action==='start'){if(state.phase!=='idle')throw new Error('Bed screw session already active');next={phase:'adjust',current:0,accepted:0};}
 else{
  if(!['accept','adjusted'].includes(action)||state.phase==='idle'||state.current>=(state.phase==='adjust'?plan.coarse:plan.fine).length)throw new Error('No current bed screw');
  const accepted=action==='adjusted'?0:state.accepted+1,count=(state.phase==='adjust'?plan.coarse:plan.fine).length;
  if(state.current+1<count&&accepted<plan.coarse.length)next={phase:state.phase,current:state.current+1,accepted};
  else if(accepted<plan.coarse.length)next={phase:'adjust',current:0,accepted};
  else if(state.phase==='adjust'&&plan.fine.length)next={phase:'fine',current:0,accepted:0};
  else next=initialBedScrewsState();
 }
 const raised=[...position];raised[2]=Math.max(position[2],plan.horizontalHeight);
 const moves=[{position:raised,speed:plan.liftSpeed}];
 if(next.phase!=='idle'){
  const point=(next.phase==='adjust'?plan.coarse:plan.fine)[next.current],over=[point.position[0],point.position[1],raised[2],position[3]];
  moves.push({position:over,speed:plan.travelSpeed},{position:[over[0],over[1],plan.contactHeight,over[3]],speed:plan.liftSpeed});
 }
 return {state:next,moves};
}
