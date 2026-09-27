// Heater-linked cooling policy from klippy/extras/heater_fan.py.
// GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {WaitTemperature} from './temperature-wait.ts';
export interface HeaterFanPolicy {readonly heaters:readonly string[];readonly threshold:number;readonly speed:number;}
/** Validate all referenced heaters before allocating outputs or starting IO. */
export function readHeaterFanPolicy(reader:ConfigurationReader,section:string,available:readonly string[]):HeaterFanPolicy{
 if(!section.startsWith('heater_fan ')||!section.slice(11).trim())throw new Error('Invalid heater fan section');
 const config=reader.section(section),heaters=config.get('heater',{defaultValue:'extruder'}).split(',').map(n=>n.trim());
 const known=new Set(available.map(n=>n.trim().split(/\s+/).at(-1)!));
 if(!heaters.length||heaters.length>64||heaters.some(n=>!n||!known.has(n))||new Set(heaters).size!==heaters.length)throw new Error('Invalid heater fan heater references');
 return Object.freeze({heaters:Object.freeze(heaters),threshold:config.getFloat('heater_temp',{defaultValue:50}),speed:config.getFloat('fan_speed',{defaultValue:1,minval:0,maxval:1})});
}
/** Stale readings cannot authorize cooling off. Hardware shutdown is separate
 * and restores the explicitly configured firmware shutdown power. */
export function heaterFanSpeed(policy:HeaterFanPolicy,read:(name:string)=>WaitTemperature):number{
 let on=false;
 for(const name of policy.heaters){const state=read(name);if(!Number.isFinite(state.temperature)||!Number.isFinite(state.target)||state.target<0)throw new Error('Invalid heater fan temperature state');on=on||state.stale||!!state.fault||state.target!==0||state.temperature>policy.threshold;}
 return on?policy.speed:0;
}
