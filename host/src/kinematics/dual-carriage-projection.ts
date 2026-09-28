import type {CarriagePair} from './dual-carriage.ts';
import {carriagePosition} from './dual-carriage.ts';
import type {CarriageTransformSettings,StepperKinematics} from '../motion/step-compressor.ts';
export interface CarriageTopology {readonly kind:'cartesian'|'hybrid_corexy'|'hybrid_corexz';readonly axis:0|1;}
function validate(t:CarriageTopology):void{if(!['cartesian','hybrid_corexy','hybrid_corexz'].includes(t.kind)||(t.axis!==0&&t.axis!==1)||t.kind!=='cartesian'&&t.axis!==0)throw new RangeError('Invalid dual carriage topology');}
/** Ordered first-carriage and second-carriage native motor solvers. Hybrid
 * second carriages use the opposite belt coupling sign of the first carriage. */
export function carriageSolvers(t:CarriageTopology):readonly [StepperKinematics,StepperKinematics]{
 validate(t);return t.kind==='hybrid_corexy'?['corexy-','corexy+']:t.kind==='hybrid_corexz'?['corexz-','corexz+']:t.axis===0?['x','x']:['y','y'];
}
export function nativeCarriageTransforms(t:CarriageTopology,carriages:CarriagePair):readonly [CarriageTransformSettings,CarriageTransformSettings]{
 validate(t);if(carriages.length!==2)throw new RangeError('Expected two carriages');
 const values=carriages.map(c=>{carriagePosition(c,0);return Object.freeze(t.axis===0?{xScale:c.scale,xOffset:c.offset,yScale:1,yOffset:0}:{xScale:1,xOffset:0,yScale:c.scale,yOffset:c.offset});});
 return Object.freeze(values) as unknown as readonly [CarriageTransformSettings,CarriageTransformSettings];
}
/** Readback motor order is X,Y,Z,second-carriage. Only the unique PRIMARY
 * establishes logical coordinates. COPY/MIRROR motors cannot grant authority. */
export function dualCarriagePosition(t:CarriageTopology,carriages:CarriagePair,motors:readonly number[]):[number,number,number]{
 validate(t);if(motors.length!==4||!motors.every(Number.isFinite)||carriages.length!==2)throw new RangeError('Invalid carriage motor readback');
 carriages.forEach(c=>carriagePosition(c,0));const primary=carriages.map((c,i)=>c.mode==='PRIMARY'?i:-1).filter(i=>i>=0);
 if(primary.length!==1)throw new Error('Carriage readback requires one primary');
 const index=primary[0],position:[number,number,number]=[motors[0],motors[1],motors[2]];
 let physical=motors[index===0?t.axis:3];
 if(t.kind==='hybrid_corexy')physical+=index===0?motors[1]:-motors[1];
 if(t.kind==='hybrid_corexz')physical+=index===0?motors[2]:-motors[2];
 position[t.axis]=(physical-carriages[index].offset)/carriages[index].scale;
 if(!position.every(Number.isFinite))throw new RangeError('Carriage readback overflow');return position;
}
