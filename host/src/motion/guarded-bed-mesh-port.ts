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
 if(options.limits.extraAxes?.length)throw new RangeError('Guarded XYZE port owns extrusion junction checks');
 const {extrusion}=options;
 return new BedMeshMovePort({...options,limits:{...options.limits,extraAxes:[(previous,current,index)=>extrusion.junction(previous,current,index)]},validate:createMotionValidator(options)});
}
/** Shared live admission checks for initial planning and a retained resume path. */
export function createMotionValidator({kinematics,extrusion,canExtrude}:Pick<GuardedBedMeshOptions,'kinematics'|'extrusion'|'canExtrude'>):(move:Move)=>void {
 if(typeof canExtrude!=='function'||isAsyncFunction(canExtrude))throw new TypeError('Live extrusion permission is required');
 return move=>{
  if(move.isKinematic)kinematics.check(move);
  // Strict true: a Promise or other truthy value must never authorize extrusion.
  if(move.axesD[3]){const permission:unknown=canExtrude();if(isPromise(permission))void permission.catch(()=>{});extrusion.check(move,3,permission===true);}
 };
}
