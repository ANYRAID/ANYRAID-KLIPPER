// Board aliases from klippy/extras/board_pins.py. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PinResolver} from '../protocol/pins.ts';
/** Validate against resolver copies first, so late errors publish no aliases. */
export function applyConfiguredBoardPins<T>(reader:ConfigurationReader,pins:PrinterPins<T>):void{
 const copies=new Map<string,PinResolver>(),actions:{mcu:string;name:string;value:string;reserved:boolean}[]=[];
 for(const name of reader.sections().filter(n=>n==='board_pins'||n.startsWith('board_pins '))){
  const section=reader.section(name),mcus=section.getList('mcu',{separator:',',defaultValue:['mcu']});
  if(!mcus.length)throw new Error('Board pins requires at least one MCU');
  for(const mcu of mcus)if(!copies.has(mcu))copies.set(mcu,pins.resolver(mcu).clone());
  for(const option of ['aliases',...Object.keys(section.options()).filter(n=>n.startsWith('aliases_'))]){
   // Klipper preserves inner empty fields; the shared Moonraker reader drops them.
   for(const pair of section.get(option).split(',').filter(p=>p.trim())){
    const parts=pair.split('=');
    if(parts.length!==2||parts.some(p=>!p.trim()))throw new Error(`Malformed board alias in [${name}] ${option}`);
   }
   const entries=section.getLists(option,{separators:[',','='],count:[null,2]}) as [string,string][];
   for(const [name,value] of entries)for(const mcu of mcus){
    const reserved=value.startsWith('<')&&value.endsWith('>'),resolver=copies.get(mcu)!;
    if(reserved)resolver.reserveLogical(name,value);else resolver.alias(name,value);
    actions.push({mcu,name,value,reserved});
   }
  }
 }
 for(const a of actions){const resolver=pins.resolver(a.mcu);if(a.reserved)resolver.reserveLogical(a.name,a.value);else resolver.alias(a.name,a.value);}
}
