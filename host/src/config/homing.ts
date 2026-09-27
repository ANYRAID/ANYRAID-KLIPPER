import {readHomingPin} from './sensorless.ts';
// Configured GPIO endstops and trigger-sync objects. GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap} from '../protocol/pins.ts';
import {mcuOids,type MCUOidRequest} from '../protocol/mcu-oids.ts';
import type {StepperMCU} from './stepper.ts';
import {EndstopProtocol} from '../inputs/endstop.ts';
import {TriggerSyncProtocol} from '../inputs/trsync.ts';
export interface HomingSectionRequest {
 section:string;oid?:number;
 /** Every physical MCU participating in the stop, including the GPIO MCU.
  * Stepper membership is bound later by the homing runtime. */
 triggers:readonly {mcu:string;oid?:number}[];
}
/** Compile all GPIOs and all per-MCU trigger objects before publishing any
 * pin/OID claims. No IO and no grant of homing authority. */
export function compileConfiguredHoming<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,requests:readonly HomingSectionRequest[]){
 if(!requests.length||requests.length>64||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid configured homing batch');
 if(new Set([...mcus.values()].map(m=>m.chip)).size!==mcus.size)throw new Error('Duplicate physical MCU in homing map');
 const maps=new Map<string,PhysicalPinMap>(),oids:MCUOidRequest[]=[];
 const getMCU=(name:string)=>{const mcu=mcus.get(name);if(!mcu||pins.chip(name)!==mcu.chip)throw new Error('Homing MCU ownership differs');return mcu;};
 const entries=requests.map(request=>{
  const {description,sensorless}=readHomingPin(reader,request.section),pin=pins.parse(description,{canInvert:true,canPullup:true}),mcu=getMCU(pin.chipName),members=request.triggers.map(t=>({...t}));
  if(!members.length||members.length>16||new Set(members.map(t=>t.mcu)).size!==members.length||!members.some(t=>t.mcu===pin.chipName))throw new Error('Invalid homing trigger MCU membership');
  for(const t of members)getMCU(t.mcu);
  const resolver=pins.resolver(pin.chipName).clone(),enumeration=mcu.dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const p of value.split(','))if(p.trim())resolver.reserve(p.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${pin.pin}`])[0].slice(10),reserved=resolver.physicalReservations(enumeration);
  maps.set(pin.chipName,{pins:enumeration,reserved});
  const offset=oids.length;oids.push({mcu:pin.chipName,owner:`endstop:${request.section}`,oid:request.oid},...members.map(t=>({mcu:t.mcu,owner:`trsync:${request.section}`,oid:t.oid})));
  return {section:request.section,sensorless,description,pin,resolved,mcu,members,offset};
 });
 return mcuOids(pins).claim(oids,allocated=>{
  const plans=entries.map(e=>{
   const endstop=new EndstopProtocol(e.mcu.chip,e.mcu.dictionary,allocated[e.offset],{...e.pin,pin:e.resolved});Object.freeze(endstop);
   for(const command of [...endstop.commands,...endstop.restart])e.mcu.dictionary.encodeCommand(command);
   const triggers=Object.freeze(e.members.map((t,i)=>{const dictionary=getMCU(t.mcu).dictionary,protocol=new TriggerSyncProtocol(dictionary,allocated[e.offset+i+1]);Object.freeze(protocol);for(const command of [...protocol.commands,...protocol.restart])dictionary.encodeCommand(command);return Object.freeze({mcu:t.mcu,protocol});}));
   return {section:e.section,sensorless:e.sensorless,mcu:e.pin.chipName,endstop,triggers,primary:triggers.findIndex(t=>t.mcu===e.pin.chipName)};
  });
  const acquired=pins.lookupBatch(entries.map(e=>({description:e.description,options:{canInvert:true,canPullup:true},exclusive:true})),maps);
  return Object.freeze(plans.map((plan,i)=>Object.freeze({...plan,pin:acquired[i]})));
 });
}
