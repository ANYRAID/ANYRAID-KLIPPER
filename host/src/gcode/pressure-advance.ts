import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import type {Parameters} from './move.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import {fixed6} from '../math/python-decimal.ts';
import {planPressureAdvance,type PressureAdvanceSettings,type PressureAdvanceChange} from '../motion/pressure-advance-settings.ts';
export function pressureAdvanceCommand(params:Parameters,current:PressureAdvanceSettings,extruder='extruder'):PressureAdvanceChange{
 if(Object.hasOwn(params,'EXTRUDER')&&params.EXTRUDER!==extruder)throw new GCodeError('Unknown pressure advance extruder');
 const next={...current};for(const [key,field] of [['ADVANCE','advance'],['SMOOTH_TIME','smoothTime']] as const)if(Object.hasOwn(params,key)){try{next[field]=typeof params[key]==='number'?params[key]:parseConfigurationFloat(params[key]);}catch{throw new GCodeError(`Invalid ${key}`);}}
 try{return planPressureAdvance(current,next);}catch(error){throw new GCodeError(error instanceof Error?error.message:'Invalid pressure settings');}
}
/** A hardware implementation must serialize this operation with motion and
 * atomically publish accepted state, or retire the printer on partial failure.
 * This interface does not authorize using startup-only native setters live. */
export interface PressureAdvancePort {
 readonly name:string;
 readonly pressureAdvance:PressureAdvanceSettings;
 applyPressureAdvance(change:PressureAdvanceChange,signal:AbortSignal):Promise<void>;
}
/** Explicit opt-in only: the native product host must not register this until
 * it owns continuous scheduling, window barriers and pause recovery together. */
export function bindPressureAdvanceCommand(dispatch:GCodeDispatch,binding:PressureAdvancePort|((name?:string)=>PressureAdvancePort)):void{
 dispatch.register('SET_PRESSURE_ADVANCE',async c=>{
  const port=typeof binding==='function'?binding(c.params.EXTRUDER):binding;
  const change=pressureAdvanceCommand(c.params,port.pressureAdvance,port.name);await port.applyPressureAdvance(change,c.signal);c.signal.throwIfAborted();
  c.respondInfo(`pressure_advance: ${fixed6(change.next.advance)}\npressure_advance_smooth_time: ${fixed6(change.next.smoothTime)}`);
 });
}
