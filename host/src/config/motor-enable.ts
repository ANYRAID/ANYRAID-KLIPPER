// Shared motor-enable configuration from klippy/extras/stepper_enable.py.
// GPL-3.0-or-later.
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {PrinterPins,type PhysicalPinMap,type PinBinding} from '../protocol/pins.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
import {compileMotorEnable,compileAlwaysOnMotors} from '../outputs/motor-enable.ts';
import type {MCUGroup} from '../runtime/mcu-group.ts';
import {snapshotPrintClock} from '../timing/print-clock.ts';
export interface ConfiguredMotorEnable {
 section:string;emitter:string;mcu:string;leadTime:number;
 calibration:Readonly<{offset:number;frequency:number}>;
}
const motorOwners=new WeakMap<object,Set<string>>();
/** Assemble every member of a shared enable line together. Missing enable_pin
 * means a configured always-on motor, with no allocated GPIO or OID. No IO. */
export function compileConfiguredMotorEnables<T>(reader:ConfigurationReader,pins:PrinterPins<T>,group:MCUGroup,requests:readonly ConfiguredMotorEnable[]){
 if(!requests.length||requests.length>128||new Set(requests.map(r=>r.section)).size!==requests.length||new Set(requests.map(r=>r.emitter)).size!==requests.length)throw new Error('Invalid configured motor enable batch');
 const owned=new Set(motorOwners.get(pins));for(const r of requests)for(const key of [`section:${r.section}`,`emitter:${r.emitter}`]){if(owned.has(key))throw new Error('Duplicate configured motor owner');owned.add(key);}
 const lines=new Map<string,{mcu:string;pin:PinBinding<T>;description:string;emitters:string[];leadTime:number;calibration:Readonly<{offset:number;frequency:number}>}>(),maps=new Map<string,PhysicalPinMap>();
 const alwaysOn:ReturnType<typeof compileAlwaysOnMotors>[]=[];
 for(const request of requests){
  if(!/^[A-Za-z0-9_.:-]{1,128}$/.test(request.emitter)||!Number.isFinite(request.leadTime)||request.leadTime<=0||request.leadTime>.1)throw new Error('Invalid configured motor enable timing or emitter');
  const description=reader.section(request.section).get('enable_pin',{defaultValue:null});if(description===null){alwaysOn.push(compileAlwaysOnMotors(group,{mcu:request.mcu,emitters:[request.emitter],calibration:request.calibration}));continue;}
  const parsed=pins.parse(description,{canInvert:true});if(parsed.chipName!==request.mcu)throw new Error('Motor enable differs from motor MCU');
  const dictionary=group.session(request.mcu).dictionary,resolver=pins.resolver(request.mcu).clone(),enumeration=dictionary.pinEnumeration;
  for(const [name,value] of Object.entries(dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const pin of value.split(','))if(pin.trim())resolver.reserve(pin.trim(),name.slice(13));}
  const resolved=resolver.resolve([`claim pin=${parsed.pin}`])[0].slice(10),physical=enumeration[resolved];if(physical===undefined)throw new Error('Unknown motor enable physical pin');
  const reserved=resolver.reservedPins.map(pin=>{const id=enumeration[pin];if(id===undefined)throw new Error('Unknown reserved motor enable pin');return id;});
  maps.set(request.mcu,{pins:enumeration,reserved});
  const clock=snapshotPrintClock(request.calibration),calibration=Object.freeze({offset:clock.offset,frequency:clock.frequency}),key=`${request.mcu}:${physical}`,prior=lines.get(key);
  if(prior){if(prior.pin.invert!==parsed.invert||prior.leadTime!==request.leadTime||prior.calibration.offset!==calibration.offset||prior.calibration.frequency!==calibration.frequency)throw new Error('Shared motor enable polarity or timing differs');prior.emitters.push(request.emitter);}
  else lines.set(key,{mcu:request.mcu,pin:Object.freeze({...parsed,pin:resolved}),description,emitters:[request.emitter],leadTime:request.leadTime,calibration});
 }
 const entries=[...lines.entries()];
 const build=(oids:readonly number[])=>{
  const plans=Object.freeze(entries.map(([,line],i)=>{
   const plan=compileMotorEnable(group,{...line,chip:line.pin.chip,oid:oids[i]});plan.session.dictionary.encodeCommand(plan.config.restart);return plan;
  }));
  // One exclusive owner per physical line. Shared motors belong to this plan,
  // rather than acquiring independently mutable GPIO owners.
  if(entries.length)pins.lookupBatch(entries.map(([,line])=>({description:line.description,options:{canInvert:true},exclusive:true})),maps);
  motorOwners.set(pins,owned);
  return Object.freeze({lines:plans,alwaysOn:Object.freeze(alwaysOn)});
 };
 return entries.length?mcuOids(pins).claim(entries.map(([key,line])=>({mcu:line.mcu,owner:`motor_enable:${key}`})),build):build([]);
}
