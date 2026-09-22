// Integer position deltas used by klippy/extras/homing.py. GPL-3.0-or-later.
import {StepHistory} from '../motion/step-history.ts';
import type {HomingStopResult} from './stop-confirmation.ts';
export interface HomingHistoryBinding {readonly member:number;readonly oid:number;readonly history:StepHistory;}
/** Each trigger clock must already be mapped into its MCU's clock domain.
 * No conversion via Number or assumption of identical MCU clocks is made here.
 * Produces deltas only; resetting native queues and granting homing are separate. */
export function homingPositionOffsets(result:HomingStopResult,bindings:readonly HomingHistoryBinding[],triggerClocks:readonly bigint[]){
 if(result.hitClock===null)throw new Error('Homing did not trigger');
 return positionOffsets(result,bindings,triggerClocks);
}
function positionOffsets(result:HomingStopResult,bindings:readonly HomingHistoryBinding[],triggerClocks:readonly bigint[]){
 if(bindings.length!==result.positions.length||!bindings.length||triggerClocks.length!==result.reasons.length)throw new Error('Incomplete homing history');
 const byKey=new Map<string,StepHistory>();
 for(const b of bindings){if(!Number.isInteger(b.member)||b.member<0||b.member>=triggerClocks.length||!Number.isInteger(b.oid)||b.oid<0||b.oid>254||!(b.history instanceof StepHistory))throw new Error('Invalid homing history binding');const key=`${b.member}:${b.oid}`;if(byKey.has(key))throw new Error('Duplicate homing history');byKey.set(key,b.history);}
 const positions=result.positions.map(p=>{
  const key=`${p.member}:${p.oid}`,history=byKey.get(key);if(!history)throw new Error('Missing or duplicate homing position');byKey.delete(key);
  const clock=triggerClocks[p.member];if(typeof clock!=='bigint'||clock>p.observedClock)throw new Error('Invalid mapped trigger clock');
  const start=history.at(history.status.fromClock),trigger=history.at(clock),halt=p.position;
  return Object.freeze({member:p.member,oid:p.oid,start,trigger,halt,triggerOffset:trigger-start,haltOffset:halt-start,overshoot:halt-trigger});
 });
 return Object.freeze(positions);
}

import type {HomingStopSetResult} from './stop-set.ts';
/** Independent switches have independent trigger times, even on the same MCU.
 * Each row of triggerClocks is mapped within that group's MCU domains. */
export function homingSetPositionOffsets(result:HomingStopSetResult,bindings:readonly HomingHistoryBinding[],triggerClocks:readonly (readonly bigint[])[]){
 return setOffsets(result,bindings,triggerClocks,true);
}
/** Recovery only: missing-hit groups use caller-provided end-of-movement clocks.
 * These reference positions are not endstop hits or homed-axis authority. */
export function homingSetRecoveryOffsets(result:HomingStopSetResult,bindings:readonly HomingHistoryBinding[],referenceClocks:readonly (readonly bigint[])[]){
 const offsets=setOffsets(result,bindings,referenceClocks,false);
 return Object.freeze({offsets,missingHits:Object.freeze(result.groups.flatMap((g,i)=>g.hitClock===null?[i]:[]))});
}
function setOffsets(result:HomingStopSetResult,bindings:readonly HomingHistoryBinding[],triggerClocks:readonly (readonly bigint[])[],requireHit:boolean){
 if(result.hitClock!==null||!result.groups.length||result.groups.length!==result.memberOffsets.length||triggerClocks.length!==result.groups.length||bindings.length!==result.positions.length)throw new Error('Invalid independent homing history');
 let member=0,position=0;
 const offsets:ReturnType<typeof homingPositionOffsets>[number][]=[];
 for(const [i,group] of result.groups.entries()){
  if(result.memberOffsets[i]!==member||group.reasons.some((r,j)=>result.reasons[member+j]!==r))throw new Error('Invalid homing member mapping');
  for(const p of group.positions){const flat=result.positions[position++];if(!flat||flat.member!==member+p.member||flat.oid!==p.oid||flat.raw!==p.raw||flat.position!==p.position||flat.observedClock!==p.observedClock)throw new Error('Inconsistent independent homing position');}
  const local=bindings.filter(b=>b.member>=member&&b.member<member+group.reasons.length).map(b=>({...b,member:b.member-member}));
  offsets.push(...(requireHit?homingPositionOffsets:positionOffsets)(group,local,triggerClocks[i]).map(p=>Object.freeze({...p,member:member+p.member})));
  member+=group.reasons.length;
 }
 if(member!==result.reasons.length||position!==result.positions.length)throw new Error('Incomplete independent homing mapping');
 return Object.freeze(offsets);
}
