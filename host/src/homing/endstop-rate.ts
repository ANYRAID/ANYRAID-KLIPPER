// Original HomingMove._calc_endstop_rate, klippy/extras/homing.py.
// GPL-3.0-or-later. Uses the same native actuator projection as Python/CFFI.
import type {StepCompressor} from '../motion/step-compressor.ts';
import type {EndstopProtocol,EndstopSampling} from '../inputs/endstop.ts';
export interface EndstopActuator {readonly stepper:StepCompressor;readonly stepDistance:number;}
/** XYZ kinematic steppers belonging to ONE endstop, including coupled motors.
 * No step rounding: upstream chooses the fastest fractional actuator step rate.
 * Caller owns the verified endstop/stepper membership and coordinate frames. */
export function endstopRestTime(start:readonly number[],end:readonly number[],speed:number,actuators:readonly EndstopActuator[]):number {
 if(start.length<3||start.length!==end.length||!start.every(Number.isFinite)||!end.every(Number.isFinite)||!Number.isFinite(speed)||speed<=0||!actuators.length||actuators.length>128||new Set(actuators.map(a=>a.stepper)).size!==actuators.length||actuators.some(a=>!Number.isFinite(a.stepDistance)||a.stepDistance<=0))throw new RangeError('Invalid endstop rate input');
 const delta=end.slice(0,3).map((v,i)=>v-start[i]),distance=Math.sqrt(delta.reduce((sum,d)=>sum+d*d,0)),duration=distance/speed;
 if(!Number.isFinite(duration))throw new RangeError('Endstop move duration overflow');
 let maxSteps=0;
 for(const a of actuators){const from=a.stepper.coordinatePosition(start[0],start[1],start[2]),to=a.stepper.coordinatePosition(end[0],end[1],end[2]),steps=Math.abs(from-to)/a.stepDistance;if(!Number.isFinite(steps))throw new RangeError('Endstop step count overflow');maxSteps=Math.max(maxSteps,steps);}
 const rest=maxSteps<=0?.001:duration/maxSteps;
 if(!Number.isFinite(rest)||rest<=0)throw new RangeError('Unrepresentable endstop sampling interval');return rest;
}
/** Standard G28 debounce: 15us samples, four matches; actual rest ticks are
 * mapped by EndstopProtocol in the primary MCU's calibrated clock domain. */
export function homingEndstopSampling(endstop:EndstopProtocol,primary:StepCompressor,trsyncOid:number,printTime:number,start:readonly number[],end:readonly number[],speed:number,actuators:readonly EndstopActuator[]):EndstopSampling {
 if(!actuators.some(a=>a.stepper===primary))throw new Error('Endstop primary is not a participating actuator');
 return endstop.home({printTime,sampleTime:.000015,sampleCount:4,restTime:endstopRestTime(start,end,speed,actuators),trsyncOid},t=>primary.clockAt(t));
}
