// Command semantics from klippy/toolhead.py; GPL-3.0-or-later.
// Copyright (C) 2016-2025 Kevin O'Connor.
import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import type {Parameters} from './move.ts';
import type {VelocitySettings,VelocityUpdate} from '../motion/velocity-limits.ts';
import {resolveVelocitySettings,VelocityUpdateUnavailable} from '../motion/velocity-limits.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import {fixed6} from '../math/python-decimal.ts';
function read(params:Parameters,key:string,zero=false,below?:number):number|undefined {
 if(!Object.hasOwn(params,key))return undefined;
 let value:number;try{value=typeof params[key]==='number'?params[key]:parseConfigurationFloat(params[key]);}catch{throw new GCodeError(`Invalid ${key}`);}
 if(!Number.isFinite(value)||(zero?value<0:value<=0)||below!==undefined&&value>=below)throw new GCodeError(`Invalid ${key}`);return value;
}
export function velocityUpdate(command:string,params:Parameters):VelocityUpdate|undefined {
 if(command==='M204'){const s=read(params,'S');if(s!==undefined)return {maxAccel:s};const p=read(params,'P'),t=read(params,'T');return p===undefined||t===undefined?undefined:{maxAccel:Math.min(p,t)};}
 if(command!=='SET_VELOCITY_LIMIT')throw new GCodeError('Unknown velocity command');
 const next:VelocityUpdate={};for(const [key,field,zero,below] of [['VELOCITY','maxVelocity',false,undefined],['ACCEL','maxAccel',false,undefined],['SQUARE_CORNER_VELOCITY','squareCornerVelocity',true,undefined],['MINIMUM_CRUISE_RATIO','minCruiseRatio',true,1]] as const){const value=read(params,key,zero,below);if(value!==undefined)next[field]=value;}return next;
}
export interface VelocityPort {readonly velocitySettings:VelocitySettings;updateVelocityLimits(patch:VelocityUpdate):void;}
export function bindVelocityCommands(dispatch:GCodeDispatch,port:VelocityPort):void {
 for(const name of ['M204','SET_VELOCITY_LIMIT'])dispatch.register(name,c=>{
  const patch=velocityUpdate(name,c.params);if(patch===undefined){c.respondInfo(`Invalid M204 command "${c.commandline}"`);return;}
  try{resolveVelocitySettings({...port.velocitySettings,...patch});}catch{throw new GCodeError('Motion limit arithmetic overflow');}
  if(Object.keys(patch).length){try{port.updateVelocityLimits(patch);}catch(error){if(error instanceof VelocityUpdateUnavailable)throw new GCodeError(error.message);throw error;}}
  else {const s=port.velocitySettings;c.respondInfo(`max_velocity: ${fixed6(s.maxVelocity)}\nmax_accel: ${fixed6(s.maxAccel)}\nminimum_cruise_ratio: ${fixed6(s.minCruiseRatio)}\nsquare_corner_velocity: ${fixed6(s.squareCornerVelocity)}`);}
 });
}
