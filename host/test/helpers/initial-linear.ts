import {initialMotionFixture,initialMotionOptions} from './initial-motion.ts';
import {initializeConfiguredMotion} from '../../src/runtime/initial-motion.ts';
import {compileLinearHoming,type ConfiguredLinearHoming} from '../../src/config/linear-homing.ts';
export async function initialLinearFixture(reverse=false,bed=false){
 const f=await initialMotionFixture(reverse,true,bed);try{
  const initial=await initializeConfiguredMotion(f.hardware,{...initialMotionOptions,fanSection:'fan'},f.signal);
  const homing=f.hardware.plan.homing.map(h=>[{section:h.section,emitters:initial.emitters.map(e=>e.id)}]);
  const configuredSettings:ConfiguredLinearHoming={kinematicIds:['x','y','z'],homing:homing as unknown as ConfiguredLinearHoming['homing']};
  const settings=compileLinearHoming(f.hardware.plan,initial.generation,configuredSettings);
  return {...f,initial,settings,configuredSettings};
 }catch(error){await f.close();throw error;}
}
