// Firmware retraction semantics from klippy/extras/firmware_retraction.py.
// Copyright (C) 2019 Len Trigg; GPL-3.0-or-later.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import type {GCodeMove,Parameters} from './move.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import {fixedDecimal} from '../math/python-decimal.ts';
export interface RetractionSettings {retract_length:number;retract_speed:number;unretract_extra_length:number;unretract_speed:number;}
export function validateRetraction(s:RetractionSettings):RetractionSettings {
 for(const [key,min] of [['retract_length',0],['retract_speed',1],['unretract_extra_length',0],['unretract_speed',1]] as const)if(!Number.isFinite(s[key])||s[key]<min)throw new GCodeError(`Invalid ${key}`);
 if(!Number.isFinite(s.retract_length+s.unretract_extra_length)||!Number.isFinite(s.retract_speed*60)||!Number.isFinite(s.unretract_speed*60))throw new GCodeError('Retraction arithmetic overflow');return {...s};
}
/** Retraction owns its latch, without reserving or overwriting a macro state name.
 * Both state and latch change only after synchronous motion admission succeeds. */
export class FirmwareRetraction {
 #settings:RetractionSettings;#retracted=false;
 constructor(settings:RetractionSettings){this.#settings=validateRetraction(settings);}
 get status():RetractionSettings{return {...this.#settings};}
 get retracted():boolean{return this.#retracted;}
 configure(params:Parameters):void {
  const next={...this.#settings};for(const key of Object.keys(next) as (keyof RetractionSettings)[]){const name=key.toUpperCase();if(Object.hasOwn(params,name)){try{next[key]=typeof params[name]==='number'?params[name]:parseConfigurationFloat(params[name]);}catch{throw new GCodeError(`Invalid ${name}`);}}}
  this.#settings=validateRetraction(next);this.#retracted=false;
 }
 move(coordinates:GCodeMove,retract:boolean):void {
  if(this.#retracted===retract)return;
  const s=this.#settings,length=retract?-s.retract_length:s.retract_length+s.unretract_extra_length;
  // Python's generated G1 used %.5f for E and %d for feed rate.
  coordinates.temporaryExtrusion(Number(fixedDecimal(length,5)),Math.trunc((retract?s.retract_speed:s.unretract_speed)*60));this.#retracted=retract;
 }
 register(dispatch:GCodeDispatch,coordinates:GCodeMove):void {
  dispatch.register('SET_RETRACTION',c=>this.configure(c.params));
  dispatch.register('GET_RETRACTION',c=>c.respondInfo(Object.entries(this.#settings).map(([k,v])=>`${k.toUpperCase()}=${fixedDecimal(v,5)}`).join(' ')));
  dispatch.register('G10',()=>this.move(coordinates,true));dispatch.register('G11',()=>this.move(coordinates,false));
 }
}
