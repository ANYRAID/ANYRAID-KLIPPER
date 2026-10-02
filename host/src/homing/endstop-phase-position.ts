import type {LinearKinematics,Axis} from '../kinematics/linear.ts';
/** Same home_rails_end ordering as upstream: adjust the representative motor,
 * invert kinematics, then adopt only the axis selected by this homing rail. */
export function endstopPhasePosition(kinematics:LinearKinematics,position:readonly number[],actuators:readonly number[],axis:Axis,adjustment:number):readonly number[]{
 if(position.length<4||!position.every(Number.isFinite)||actuators.length!==3||!actuators.every(Number.isFinite)||!Number.isInteger(axis)||axis<0||axis>2||!Number.isFinite(adjustment))throw new Error('Invalid phase correction coordinates');
 const shifted=[...actuators];shifted[axis]+=adjustment;
 const corrected=kinematics.calcPosition(shifted),result=[...position];result[axis]=corrected[axis];return Object.freeze(result);
}
