import type {Move} from './lookahead.ts';
/** Fixed-window changes selected by the original C source-phase clock. */
export interface PressureBoundary {readonly stepper:string;readonly advance:number;}
export interface TimedPressureBoundary extends PressureBoundary {readonly time:number;}
export function validatePressureBoundaries(changes:readonly PressureBoundary[]|undefined):void{
 if(changes===undefined)return;
 if(!Array.isArray(changes)||changes.length>64)throw new RangeError('Invalid pressure boundary batch');
 const seen=new Set<string>();for(const c of changes){if(!c||typeof c.stepper!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(c.stepper)||seen.has(c.stepper)||!Number.isFinite(c.advance)||c.advance<=0)throw new RangeError('Invalid pressure boundary');seen.add(c.stepper);}
}
export function copyPressureBoundaries(changes:readonly PressureBoundary[]|undefined):readonly PressureBoundary[]|undefined{
 if(changes===undefined)return;validatePressureBoundaries(changes);return Object.freeze(changes.map(c=>Object.freeze({stepper:c.stepper,advance:c.advance})));
}
/** Last request for one emitter at the same endpoint wins without forcing a
 * lookahead flush. Data follows its geometric endpoint across replanning. */
export function markPressureBoundary(move:Move,change:PressureBoundary):void{
 const changes=[...move.pressureBoundaries??[]].filter(c=>c.stepper!==change.stepper);changes.push(change);move.pressureBoundaries=copyPressureBoundaries(changes);
}
export function pressureBoundarySchedule(moves:readonly Move[],start:number):readonly TimedPressureBoundary[]{
 if(!Number.isFinite(start)||start<0||start>=1e15)throw new RangeError('Invalid pressure source time');
 const result:TimedPressureBoundary[]=[];let time=start;
 for(const m of moves){validatePressureBoundaries(m.pressureBoundaries);const p=m.profile;if(!p||![p.accelT,p.cruiseT,p.decelT].every(v=>Number.isFinite(v)&&v>=0))throw new RangeError('Pressure boundary requires planned motion');const previous=time;time=((time+p.accelT)+p.cruiseT)+p.decelT;if(!Number.isFinite(time)||time>=1e15||time<=previous)throw new RangeError('Invalid pressure endpoint time');for(const c of m.pressureBoundaries??[])result.push(Object.freeze({...c,time}));}
 return Object.freeze(result);
}
