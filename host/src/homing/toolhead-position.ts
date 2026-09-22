// Coordinate reconstruction from klippy/extras/homing.py (GPL-3.0-or-later).
import type {homingPositionOffsets} from './position-offsets.ts';
type Offset=ReturnType<typeof homingPositionOffsets>[number];
export interface HomingActuator {
 readonly id:string;readonly commanded:number;readonly stepDistance:number;
 /** Omit both for a kinematic actuator not participating in this stop. */
 readonly member?:number;readonly oid?:number;
}
export interface HomingCoordinates {
 readonly mode:'probe'|'home';
 /** Probe: pre-move commanded coordinates. Home: commanded coordinates at
  * the assigned endstop target. Include every kinematic actuator. */
 readonly actuators:readonly HomingActuator[];
 readonly offsets:readonly Offset[];
 /** Probe: current toolhead position (including extra axes). Home: target. */
 readonly reference:readonly number[];
 /** Existing inverse kinematics; null XYZ axes retain the reference value. */
 readonly calculate:(positions:ReadonlyMap<string,number>)=>readonly (number|null)[];
}
function shifted(base:number,steps:bigint,distance:number):number{
 // Never convert absolute counters; subtract in integer space first.
 if(typeof steps!=='bigint'||steps>4503599627370495n||steps< -4503599627370495n)throw new RangeError('Homing displacement exceeds exact step range');
 const count=Number(steps),value=base+count*distance;
 if(!Number.isFinite(value)||base+distance*.5===base||base-distance*.5===base||value+distance*.5===value||value-distance*.5===value||Math.abs((value-base)/distance-count)>.25)throw new RangeError('Homing coordinate loses step precision');
 return value;
}
/** Pure reconstruction only: no native reset, motor movement or homed flags.
 * Probe reports actual trigger/halt displacement from the saved start. Home
 * assigns the target to the trigger and adds only post-trigger overshoot. */
export function homingToolheadPositions(o:HomingCoordinates){
 if(o.mode!=='probe'&&o.mode!=='home'||!Array.isArray(o.reference)||o.reference.length<3||o.reference.length>64||!o.reference.every(Number.isFinite)||!o.actuators.length||o.actuators.length>128||typeof o.calculate!=='function')throw new RangeError('Invalid homing coordinates');
 const reference=[...o.reference],inverse=o.calculate;
 const offsets=new Map<string,Offset>();
 for(const p of o.offsets){const key=`${p.member}:${p.oid}`;
  if(!Number.isInteger(p.member)||p.member<0||p.member>=128||!Number.isInteger(p.oid)||p.oid<0||p.oid>254||offsets.has(key)||![p.start,p.trigger,p.halt,p.triggerOffset,p.haltOffset,p.overshoot].every(v=>typeof v==='bigint')||p.trigger-p.start!==p.triggerOffset||p.halt-p.start!==p.haltOffset||p.halt-p.trigger!==p.overshoot)throw new RangeError('Invalid homing step offsets');
  offsets.set(key,{...p});
 }
 if(!offsets.size)throw new RangeError('Missing homing step offsets');
 const ids=new Set<string>(),bindings=o.actuators.map(a=>{
  if(typeof a.id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(a.id)||ids.has(a.id)||!Number.isFinite(a.commanded)||!Number.isFinite(a.stepDistance)||a.stepDistance<=0)throw new RangeError('Invalid homing actuator');ids.add(a.id);
  let offset:Offset|undefined;
  if(a.member!==undefined||a.oid!==undefined){const key=`${a.member}:${a.oid}`;offset=offsets.get(key);if(!offset)throw new RangeError('Missing or duplicate homing actuator offset');offsets.delete(key);}
  return {...a,offset};
 });
 if(offsets.size)throw new RangeError('Unmapped homing step offsets');
 const calculate=(field:'triggerOffset'|'haltOffset'|'overshoot')=>{
  const positions=new Map(bindings.map(a=>[a.id,shifted(a.commanded,a.offset?.[field]??0n,a.stepDistance)]));
  const xyz=inverse(positions);
  if(!Array.isArray(xyz)||xyz.length!==3||xyz.some(v=>v!==null&&!Number.isFinite(v)))throw new RangeError('Invalid reconstructed toolhead position');
  return Object.freeze([...xyz.map((v,i)=>v??reference[i]),...reference.slice(3)]);
 };
 const overshoot=bindings.some(a=>a.offset?.overshoot!==undefined&&a.offset.overshoot!==0n);
 const trigger=o.mode==='probe'?calculate('triggerOffset'):Object.freeze([...reference]);
 const halt=overshoot?calculate(o.mode==='probe'?'haltOffset':'overshoot'):trigger;
 return Object.freeze({trigger,halt});
}
