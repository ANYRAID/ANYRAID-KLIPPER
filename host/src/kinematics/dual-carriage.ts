// GPL-3.0-or-later. IDEX semantics from klippy/kinematics/idex_modes.py.
// Copyright (C) 2021 Fabrice Gallet, 2023-2025 Dmitry Butyugin.
export type CarriageMode='INACTIVE'|'PRIMARY'|'COPY'|'MIRROR';
export interface CarriageRail {readonly minimum:number;readonly maximum:number;readonly endstop:number;readonly positiveDirection:boolean;}
export interface CarriageTransform {readonly mode:CarriageMode;readonly scale:number;readonly offset:number;}
export type CarriagePair=readonly [CarriageTransform,CarriageTransform];
const finite=(n:number)=>{if(!Number.isFinite(n))throw new RangeError('Non-finite carriage arithmetic');return n;};
function rail(r:CarriageRail){if(![r.minimum,r.maximum,r.endstop].every(Number.isFinite)||r.minimum>=r.maximum||r.endstop<r.minimum||r.endstop>r.maximum||typeof r.positiveDirection!=='boolean')throw new RangeError('Invalid carriage rail');}
function transform(t:CarriageTransform){if(!['INACTIVE','PRIMARY','COPY','MIRROR'].includes(t.mode)||![t.scale,t.offset].every(Number.isFinite)||t.mode==='INACTIVE'&&t.scale!==0||t.mode==='PRIMARY'&&t.scale!==1||t.mode==='COPY'&&t.scale<=0||t.mode==='MIRROR'&&t.scale>=0)throw new RangeError('Invalid carriage transform');}
function pair(values:CarriagePair){if(values.length!==2)throw new RangeError('Expected two carriage transforms');values.forEach(transform);if(values.filter(v=>v.mode==='PRIMARY').length>1)throw new RangeError('Multiple primary carriages');}
export function carriagePosition(t:CarriageTransform,position:number):number{transform(t);return finite(finite(position)*t.scale+t.offset);}
/** Negative means rail 0 is physically left/below rail 1. No fuzzy ordering. */
export function carriageOrder(rails:readonly [CarriageRail,CarriageRail]):-1|1{
 if(rails.length!==2)throw new RangeError('Expected two carriage rails');rails.forEach(rail);const [a,b]=rails;
 if(a.positiveDirection!==b.positiveDirection)return a.positiveDirection?1:-1;
 if(a.endstop===b.endstop)throw new RangeError('Ambiguous carriage ordering');return a.endstop>b.endstop?1:-1;
}
export function carriageSafeDistance(rails:readonly [CarriageRail,CarriageRail],configured?:number):number{
 rails.forEach(rail);const distance=configured??Math.min(Math.abs(finite(rails[0].minimum-rails[1].minimum)),Math.abs(finite(rails[0].maximum-rails[1].maximum)));if(!Number.isFinite(distance)||distance<0)throw new RangeError('Invalid carriage safe distance');return distance;
}
/** Pure proposal. The owner must drain steps, apply native transforms and rebase
 * the toolhead atomically before publishing this state. No homing is granted. */
export function planCarriageMode(current:CarriagePair,position:number,index:0|1,mode:CarriageMode,homed:boolean):{position:number;carriages:CarriagePair}{
 pair(current);finite(position);if(index!==0&&index!==1||!['INACTIVE','PRIMARY','COPY','MIRROR'].includes(mode)||typeof homed!=='boolean')throw new RangeError('Invalid carriage mode request');
 const other=index===0?1:0,physical=current.map(t=>carriagePosition(t,position)),next=current.map(t=>({...t}));
 if(mode==='COPY'||mode==='MIRROR'){if(!homed||current[other].mode!=='PRIMARY')throw new Error('Copy/mirror requires homed axis and another primary carriage');}
 if(mode==='INACTIVE'&&current[other].mode==='INACTIVE')throw new Error('Cannot deactivate the only active carriage');
 if(mode==='PRIMARY'){
  next[other]={mode:'INACTIVE',scale:0,offset:physical[other]};position=physical[index];next[index]={mode:'PRIMARY',scale:1,offset:0};
 }else{const scale=mode==='INACTIVE'?0:mode==='MIRROR'?-1:1;next[index]={mode,scale,offset:finite(physical[index]-finite(position*scale))};}
 return {position,carriages:Object.freeze(next.map(t=>Object.freeze(t))) as unknown as CarriagePair};
}
/** Intersect physical rail bounds and affine separation constraints. null means
 * no admissible movement, including copy mode already inside the safety gap.
 * scale=0 is a parked carriage; its position still constrains the moving peer. */
export function dualCarriageRange(rails:readonly [CarriageRail,CarriageRail],carriages:CarriagePair,safeDistance?:number):readonly [number,number]|null{
 pair(carriages);const order=carriageOrder(rails),safe=carriageSafeDistance(rails,safeDistance);let minimum=-Infinity,maximum=Infinity,active=false;
 for(let i=0;i<2;i++){const t=carriages[i];if(t.mode==='INACTIVE')continue;active=true;const a=finite((rails[i].minimum-t.offset)/t.scale),b=finite((rails[i].maximum-t.offset)/t.scale);minimum=Math.max(minimum,Math.min(a,b));maximum=Math.min(maximum,Math.max(a,b));}
 if(!active)return null;
 if(safe){const low=order<0?0:1,high=1-low,scale=finite(carriages[high].scale-carriages[low].scale),offset=finite(carriages[high].offset-carriages[low].offset);
  if(scale===0){if(offset<safe)return null;}
  else{const boundary=finite(finite(safe-offset)/scale);if(scale>0)minimum=Math.max(minimum,boundary);else maximum=Math.min(maximum,boundary);}
 }
 return minimum>maximum?null:Object.freeze([minimum,maximum] as const);
}
/** Same-direction homing starts with the carriage furthest in that direction. */
export function carriageHomingOrder(rails:readonly [CarriageRail,CarriageRail]):readonly [0|1,0|1]{return (carriageOrder(rails)>0)!==rails[0].positiveDirection?[1,0]:[0,1];}
