// Layer metadata rules from klippy/extras/print_stats.py (GPL-3.0-or-later).
// Original Copyright (C) 2020 Eric Callahan.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import {parseConfigurationInteger} from '../moonraker/config-reader.ts';
function integer(params:Readonly<Record<string,string>>,key:string,fallback:number|null):number|null{
 if(!Object.hasOwn(params,key))return fallback;try{const value=parseConfigurationInteger(params[key]);if(value<0)throw new Error();return value;}catch{throw new GCodeError(`Invalid ${key}`);}
}
/** Slicer metadata only. Never controls motion, lifecycle or completion. */
export class PrintLayerInfo {
 #total:number|null=null;#current:number|null=null;#requestId:string|undefined;
 get requestId(){return this.#requestId;}
 get status(){return {total_layer:this.#total,current_layer:this.#current};}
 reset(requestId?:string){if(requestId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))throw new TypeError('Invalid layer metadata request');this.#requestId=requestId;this.#total=this.#current=null;}
 update(params:Readonly<Record<string,string>>){
  const total=integer(params,'TOTAL_LAYER',this.#total),current=integer(params,'CURRENT_LAYER',this.#current);let nextTotal=this.#total,nextCurrent=this.#current;
  if(total===0){nextTotal=nextCurrent=null;}else if(total!==nextTotal){nextTotal=total;nextCurrent=0;}
  if(nextTotal!==null&&current!==null&&current!==nextCurrent)nextCurrent=Math.min(current,nextTotal);
  this.#total=nextTotal;this.#current=nextCurrent;
 }
 register(dispatch:GCodeDispatch){dispatch.register('SET_PRINT_STATS_INFO',command=>this.update(command.params));}
}
