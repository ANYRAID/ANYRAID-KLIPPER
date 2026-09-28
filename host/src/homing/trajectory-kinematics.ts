import type {Axis} from '../kinematics/linear.ts';
import type {Move} from '../motion/lookahead.ts';
/** Privileged trajectory only; never used for ordinary move admission. */
export interface HomingTrajectoryKinematics {
 planHomingAxisMove(start:readonly number[],end:readonly number[],speed:number,axis:Axis):Move;
 planProbeAxisMove?(start:readonly number[],end:readonly number[],speed:number,axis:Axis):Move;
}
