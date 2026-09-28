import {DeltaKinematics} from '../kinematics/delta.ts';
import {NativeLinearHomingPort,type NativeLinearPortOptions} from './native-linear-port.ts';
import type {HomingGroupConfig} from './group-plan.ts';
export interface NativeDeltaPortOptions extends Omit<NativeLinearPortOptions,'kinematics'|'groupsByAxis'|'probeHoming'|'safeZHoming'|'endstopPhases'> {
 kinematics:DeltaKinematics;
 groups:readonly HomingGroupConfig[];
}
/** Shares the generation, thermal admission, streaming and pause owner with
 * linear machines. Delta G28 uses only the simultaneous Z operation slot. */
export class NativeDeltaHomingPort extends NativeLinearHomingPort {
 constructor({groups,...options}:NativeDeltaPortOptions){super({...options,groupsByAxis:[groups,groups,groups]});}
}
