import {GCodeError,type GCodeDispatch} from './dispatch.ts';
import {parseConfigurationFloat} from '../moonraker/config-reader.ts';
import type {Tmc220xCurrent} from '../drivers/tmc220x-current.ts';
export function bindTmcCurrent(dispatch:GCodeDispatch,drivers:readonly {section:string;current:Tmc220xCurrent}[]){
 if(!drivers.length)return;
 dispatch.register('SET_TMC_CURRENT',async c=>{
  if(Object.keys(c.params).some(k=>!['STEPPER','CURRENT','HOLDCURRENT'].includes(k)))throw new GCodeError('Invalid SET_TMC_CURRENT parameter');
  const driver=drivers.find(d=>d.section.slice(d.section.indexOf(' ')+1)===c.params.STEPPER);if(!driver)throw new GCodeError('Unknown TMC stepper');
  const change:{run?:number;hold?:number}={};
  for(const [key,field] of [['CURRENT','run'],['HOLDCURRENT','hold']] as const)if(Object.hasOwn(c.params,key)){
   let value:number;try{value=parseConfigurationFloat(c.params[key]);}catch{throw new GCodeError('Invalid TMC current');}
   if(value<0||value>2||(field==='hold'&&value===0))throw new GCodeError('Invalid TMC current');change[field]=value;
  }
  await driver.current.set(change,c.signal);const value=driver.current.current;c.respondInfo(`Run Current: ${value.runCurrent.toFixed(2)}A Hold Current: ${value.holdCurrent.toFixed(2)}A`);
 },{drainBefore:true});
}
