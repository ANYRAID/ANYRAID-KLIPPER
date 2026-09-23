import {initialMotionFixture,initialMotionOptions} from './initial-motion.ts';
import {initializeConfiguredMotion} from '../../src/runtime/initial-motion.ts';
import type {ConfiguredLinearHardware} from '../../src/config/linear-motion.ts';
export async function initialLinearFixture(reverse=false,bed=false){
 const f=await initialMotionFixture(reverse,true,bed);try{
  const initial=await initializeConfiguredMotion(f.hardware,{...initialMotionOptions,fanSection:'fan'},f.signal);
  const groups=f.hardware.plan.homing.map(h=>[{members:[{physicalMember:0,trigger:h.triggers[0].protocol,emitters:initial.emitters.map(e=>e.id)}],primary:0,endstop:h.endstop,expireTimeout:.25}]);
  const settings:Omit<ConfiguredLinearHardware,'generation'|'emitters'|'canExtrude'>={kinematicIds:['x','y','z'],groupsByAxis:groups as unknown as ConfiguredLinearHardware['groupsByAxis'],endstopNames:[['x'],['y'],['z']]};
  return {...f,initial,settings};
 }catch(error){await f.close();throw error;}
}
