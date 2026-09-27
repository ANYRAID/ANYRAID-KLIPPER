// Controller cooling policy derived from klippy/extras/controller_fan.py.
// GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
export interface ControllerFanPolicy {readonly heaters:readonly string[];readonly steppers:readonly string[];readonly speed:number;readonly idleSpeed:number;readonly idleTimeout:number;}
export function readControllerFanPolicy(reader:ConfigurationReader,section:string,heaters:readonly string[],steppers:readonly string[]):ControllerFanPolicy{
 if(!section.startsWith('controller_fan ')||!section.slice(15).trim())throw new Error('Invalid controller fan section');
 const config=reader.section(section),names=(key:string,fallback:string,known:readonly string[])=>{const text=config.get(key,{defaultValue:fallback}),list=text.trim()?text.split(',').map(n=>n.trim()):[];if(list.length>128||list.some(n=>!known.includes(n))||new Set(list).size!==list.length)throw new Error('Invalid controller fan '+key+' references');return Object.freeze(list);};
 const speed=config.getFloat('fan_speed',{defaultValue:1,minval:0,maxval:1});
 return Object.freeze({heaters:names('heater','extruder',heaters.map(n=>n.trim().split(/\s+/).at(-1)!)),steppers:names('stepper',steppers.join(','),steppers),speed,idleSpeed:config.getFloat('idle_speed',{defaultValue:speed,minval:0,maxval:1}),idleTimeout:config.getInt('idle_timeout',{defaultValue:30,minval:0})});
}
/** Elapsed monotonic time, independent of extra kick-settling callbacks.
 * Idle timeout starts at the first inactive observation after activity. */
export class ControllerFanState {
 #active=false;#idleSince:number|undefined;#last=-Infinity;#policy:ControllerFanPolicy;
 constructor(policy:ControllerFanPolicy){this.#policy=policy;}
 speed(now:number,active:boolean):number{
  if(!Number.isFinite(now)||now<this.#last||typeof active!=='boolean')throw new Error('Invalid controller fan activity clock');this.#last=now;
  if(active){this.#active=true;this.#idleSince=undefined;return this.#policy.speed;}
  if(!this.#active)return 0;
  this.#idleSince??=now;
  return now-this.#idleSince<this.#policy.idleTimeout?this.#policy.idleSpeed:0;
 }
}
