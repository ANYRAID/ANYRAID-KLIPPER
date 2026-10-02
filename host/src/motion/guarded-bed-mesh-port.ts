import {isAsyncFunction,isPromise} from 'node:util/types';
import {BedMeshMovePort,type BedMeshPortOptions} from './bed-mesh-port.ts';
import {ExtrusionGuard} from './extrusion.ts';
import type {LinearKinematics} from '../kinematics/linear.ts';
import type {Move} from './lookahead.ts';
import type {DeltaKinematics} from '../kinematics/delta.ts';
export interface GuardedBedMeshOptions extends Omit<BedMeshPortOptions,'validate'> {
 kinematics:LinearKinematics|DeltaKinematics;
 extrusion:ExtrusionGuard;
 /** Read the live thermal runtime on each extruding segment. Must be synchronous. */
 canExtrude:()=>boolean;
}
/** Wires both admission checks and extrusion junction limits. Homing authority,
 * heater lifecycle and downstream hardware shutdown remain runtime-owned. */
export function createGuardedBedMeshPort(options:GuardedBedMeshOptions):BedMeshMovePort {
 if(options.physicalPosition.length!==4)throw new RangeError('Single extruder port requires XYZE');
 if(options.limits.extraAxes?.length)throw new RangeError('Guarded XYZE port owns extrusion junction checks');
 const {extrusion}=options;
 return new BedMeshMovePort({...options,limits:{...options.limits,extraAxes:[(previous,current,index)=>extrusion.junction(previous,current,index)]},validate:createMotionValidator(options)});
}
/** Shared live admission checks for initial planning and a retained resume path. */
export function createMotionValidator({kinematics,extrusion,canExtrude}:Pick<GuardedBedMeshOptions,'kinematics'|'extrusion'|'canExtrude'>):(move:Move)=>void {
 if(typeof canExtrude!=='function'||isAsyncFunction(canExtrude))throw new TypeError('Live extrusion permission is required');
 return move=>{
  if(move.axesD.length!==4)throw new RangeError('Single extruder validator requires XYZE');
  if(move.isKinematic)kinematics.check(move);
  // Strict true: a Promise or other truthy value must never authorize extrusion.
  if(move.axesD[3]){const permission:unknown=canExtrude();if(isPromise(permission))void permission.catch(()=>{});extrusion.check(move,3,permission===true);}
 };
}

export interface ExtrusionAxisPolicy {extrusion:ExtrusionGuard;canExtrude:()=>boolean;}
export interface MultiExtrusionMeshOptions extends Omit<GuardedBedMeshOptions,'extrusion'|'canExtrude'> {
 /** Ordered and complete ownership: entry zero owns axis 3, entry one axis 4. */
 extruders:readonly ExtrusionAxisPolicy[];
}
/** Every physical filament axis has its own thermal permission and junction
 * limits. Tool selection maps G-code E before this layer; no axis is implicit. */
export function createMultiExtrusionMeshPort(options:MultiExtrusionMeshOptions):BedMeshMovePort {
 const policies=ownExtruders(options.extruders);
 if(options.physicalPosition.length!==policies.length+3||options.limits.extraAxes?.length)throw new RangeError('Extruder policy ownership differs from motion axes');
 return new BedMeshMovePort({...options,limits:{...options.limits,extraAxes:policies.map(p=>(previous,current,index)=>p.extrusion.junction(previous,current,index))},validate:multiValidator(options.kinematics,policies)});
}
function ownExtruders(extruders:readonly ExtrusionAxisPolicy[]):readonly ExtrusionAxisPolicy[]{
 if(!Array.isArray(extruders)||!extruders.length||extruders.length>64||extruders.some(p=>!p||!(p.extrusion instanceof ExtrusionGuard)||typeof p.canExtrude!=='function'||isAsyncFunction(p.canExtrude)))throw new TypeError('Each extruder requires a guard and synchronous thermal permission');
 return extruders.map(p=>Object.freeze({extrusion:p.extrusion,canExtrude:p.canExtrude}));
}
function multiValidator(kinematics:GuardedBedMeshOptions['kinematics'],policies:readonly ExtrusionAxisPolicy[]):(move:Move)=>void {
 return move=>{
  if(move.axesD.length!==policies.length+3)throw new RangeError('Extruder policy ownership differs from motion axes');
  if(move.isKinematic)kinematics.check(move);
  for(let i=0;i<policies.length;i++)if(move.axesD[i+3]){const p=policies[i],permission:unknown=p.canExtrude();if(isPromise(permission))void permission.catch(()=>{});p.extrusion.check(move,i+3,permission===true);}
 };
}
/** Revalidate all filament axes when constructing a retained resume path. */
export function createMultiExtrusionValidator(kinematics:GuardedBedMeshOptions['kinematics'],extruders:readonly ExtrusionAxisPolicy[]):(move:Move)=>void {return multiValidator(kinematics,ownExtruders(extruders));}
