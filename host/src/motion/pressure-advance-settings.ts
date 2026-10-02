// Parameter/window rules from klippy/kinematics/extruder.py, GPL-3.0-or-later.
// Copyright (C) 2016-2025 Kevin O'Connor.
export interface PressureAdvanceSettings {advance:number;smoothTime:number;}
export interface PressureWindowChange extends PressureAdvanceSettings {stepper:string;}
/** Immutable admission snapshot before source padding or asynchronous work. */
export function copyPressureWindowChanges(changes:readonly PressureWindowChange[]):readonly Readonly<PressureWindowChange>[]{
 if(!Array.isArray(changes)||!changes.length||changes.length>128)throw new RangeError('Invalid pressure window changes');
 const ids=new Set<string>();
 return Object.freeze(changes.map(c=>{if(!c||typeof c.stepper!=='string'||! /^[A-Za-z0-9_.:-]{1,128}$/.test(c.stepper)||ids.has(c.stepper))throw new RangeError('Invalid pressure window emitter');ids.add(c.stepper);return Object.freeze({stepper:c.stepper,...pressureAdvanceSettings(c.advance,c.smoothTime)});}));
}
export interface PressureAdvanceChange {
 readonly previous:Readonly<PressureAdvanceSettings>;
 readonly next:Readonly<PressureAdvanceSettings>;
 readonly previousWindow:number;
 readonly nextWindow:number;
 readonly kind:'same-window'|'window-change';
}
/** Match the native numeric guard before any device or queue side effect.
 * Zero advance disables the effective window while retaining the requested
 * smoothing setting. Commands allow zero smoothing; configuration requires >0. */
export function pressureAdvanceSettings(advance:number,smoothTime:number):Readonly<PressureAdvanceSettings>{
 if(!Number.isFinite(advance)||advance<0||!Number.isFinite(smoothTime)||smoothTime<0||smoothTime>.2)throw new RangeError('Invalid pressure advance settings');
 if(advance&&smoothTime&&!Number.isFinite(1/((smoothTime*.5)*(smoothTime*.5))))throw new RangeError('Pressure smoothing exceeds numeric resolution');
 return Object.freeze({advance,smoothTime});
}
/** This is a plan only. Same-window still requires a timed source boundary;
 * window-change requires the complete generation/scan-window barrier. A caller
 * must preserve or retire all pending transitions across pause and cancellation. */
export function planPressureAdvance(previous:PressureAdvanceSettings,next:PressureAdvanceSettings):PressureAdvanceChange{
 const old=pressureAdvanceSettings(previous.advance,previous.smoothTime),value=pressureAdvanceSettings(next.advance,next.smoothTime),previousWindow=old.advance?old.smoothTime:0,nextWindow=value.advance?value.smoothTime:0;
 return Object.freeze({previous:old,next:value,previousWindow,nextWindow,kind:previousWindow===nextWindow?'same-window':'window-change'});
}
