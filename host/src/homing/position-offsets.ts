// Integer position deltas used by klippy/extras/homing.py. GPL-3.0-or-later.
import {StepHistory} from '../motion/step-history.ts';
import type {HomingStopResult} from './stop-confirmation.ts';
export interface HomingHistoryBinding {readonly member:number;readonly oid:number;readonly history:StepHistory;}
/** Each trigger clock must already be mapped into its MCU's clock domain.
 * No conversion via Number or assumption of identical MCU clocks is made here.
 * Produces deltas only; resetting native queues and granting homing are separate. */
export function homingPositionOffsets(result:HomingStopResult,bindings:readonly HomingHistoryBinding[],triggerClocks:readonly bigint[]){
 if(result.hitClock===null)throw new Error('Homing did not trigger');
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
