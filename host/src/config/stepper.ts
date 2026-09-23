// Step distance configuration from klippy/stepper.py. GPL-3.0-or-later.
import type {ConfigSection,ConfigurationReader} from '../moonraker/config-reader.ts';
import {compileStepper,type StepperConfig} from '../motion/stepper-config.ts';
import type {MessageDictionary} from '../protocol/dictionary.ts';
/** Explicit false is the PrinterStepper linear default. null requests the
 * original rotation_distance/gear_ratio inference for diagnostic consumers. */
export function readStepperDistance(section:ConfigSection,unitsInRadians:boolean|null=false){
 const radians=unitsInRadians===null?!section.hasOption('rotation_distance')&&section.hasOption('gear_ratio'):unitsInRadians;
 if(typeof radians!=='boolean')throw new TypeError('Invalid stepper units');
 if(radians&&!section.hasOption('gear_ratio'))throw new Error('Angular stepper requires gear_ratio');
 const rotationDistance=radians?2*Math.PI:section.getFloat('rotation_distance',{above:0});
 const microsteps=section.getInt('microsteps',{minval:1}),fullSteps=section.getInt('full_steps_per_rotation',{defaultValue:200,minval:1});
 if(fullSteps%4)throw new Error('full_steps_per_rotation must be divisible by four');
 const base=fullSteps*microsteps;if(!Number.isSafeInteger(base))throw new Error('Stepper integer resolution exceeds exact number range');
 const pairs=section.getLists('gear_ratio',{defaultValue:[],type:'float',separators:[',',':'],count:[null,2]}) as number[][];
 // The generic reader skips blank list items; Python's innermost gear pair
 // rejects them. Do not normalize 50::17 into a different valid gear train.
 if(section.get('gear_ratio',{defaultValue:''}).split(',').filter(p=>p.trim()).some(p=>p.split(':').length!==2||p.split(':').some(v=>!v.trim())))throw new Error('Malformed gear ratio pair');
 if(pairs.length>64)throw new Error('Stepper gear train exceeds capacity');
 let gearing=1;
 for(const [drive,driven] of pairs){if(![drive,driven].every(v=>Number.isFinite(v)&&v>0))throw new Error('Gear ratio components must be positive');gearing*=drive/driven;if(!Number.isFinite(gearing)||gearing<=0)throw new Error('Gear ratio overflow or underflow');}
 const stepsPerRotation=base*gearing,stepDistance=rotationDistance/stepsPerRotation;
 if(!Number.isFinite(stepsPerRotation)||stepsPerRotation<=0||!Number.isFinite(stepDistance)||stepDistance<=0)throw new Error('Unrepresentable step distance');
 return Object.freeze({rotationDistance,stepsPerRotation,stepDistance,microsteps,fullSteps,gearing,unitsInRadians:radians});
}
/** Pin and OID bindings are already resolved by the hardware owner. Validate
 * numerical configuration before accessing the firmware dictionary. */
export function compileConfiguredStepper<T>(reader:ConfigurationReader,name:string,chip:T,dictionary:MessageDictionary,bindings:Omit<StepperConfig<T>,'rotationDistance'|'stepsPerRotation'|'pulseDuration'>,unitsInRadians=false){
 const section=reader.section(name),distance=readStepperDistance(section,unitsInRadians),pulse=section.getFloat('step_pulse_duration',{defaultValue:null,minval:0,maxval:.001});
 const compiled=compileStepper(chip,dictionary,{...bindings,rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation,...pulse===null?{}:{pulseDuration:pulse}});
 return Object.freeze({...compiled,rotationDistance:distance.rotationDistance,stepsPerRotation:distance.stepsPerRotation});
}

import {PrinterPins,type PinRequest,type PhysicalPinMap} from '../protocol/pins.ts';
import {decodeInteger} from '../protocol/codec.ts';
import {mcuOids} from '../protocol/mcu-oids.ts';
export interface StepperSectionRequest {section:string;oid?:number;unitsInRadians?:boolean;requestBothEdges?:boolean}
export interface StepperMCU<T> {chip:T;dictionary:MessageDictionary}
const batchOwners=new WeakMap<object,{pins:Set<string>;oids:Set<string>}>();
function physicalStepPins(dictionary:MessageDictionary,config:string):number[]{
 dictionary.lookup('config_stepper oid=%c step_pin=%c dir_pin=%c invert_step=%c step_pulse_ticks=%u');
 const encoded=dictionary.encodeCommand(config);let offset=0;const numbers:number[]=[];
 for(let i=0;i<4;i++){const {value,next}=decodeInteger(encoded,offset);numbers.push(value);offset=next;}return numbers.slice(2);
}
/** Compile a whole stepper set before claiming any step/dir pins. No MCU IO.
 * OIDs default to automatic allocation in the hardware owner's shared registry.
 * Explicit IDs are supported for legacy assembly, with the same ownership rules. */
export function compileConfiguredSteppers<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,requests:readonly StepperSectionRequest[]){
 if(!requests.length||requests.length>128||new Set(requests.map(r=>r.section)).size!==requests.length)throw new Error('Invalid stepper section batch');
 const copied=requests.map(r=>({...r}));
 return mcuOids(pins).claim(copied.map(r=>({mcu:pins.parse(reader.section(r.section).get('step_pin'),{canInvert:true}).chipName,owner:r.section,oid:r.oid})),oids=>compileStepperBatch(reader,pins,mcus,copied.map((r,i)=>({...r,oid:oids[i]}))));
}
function compileStepperBatch<T>(reader:ConfigurationReader,pins:PrinterPins<T>,mcus:ReadonlyMap<string,StepperMCU<T>>,requests:readonly (StepperSectionRequest&{oid:number})[]){
 const prior=batchOwners.get(pins),physical=new Set(prior?.pins),oids=new Set(prior?.oids),reserved=new Set<string>(),claims:PinRequest[]=[],resolvers=new Map<string,ReturnType<PrinterPins<T>['resolver']>>(),wireMaps=new Map<string,PhysicalPinMap>();
 for(const binding of pins.claimedPins){
  const mcu=mcus.get(binding.chipName);if(!mcu)continue;if(mcu.chip!==binding.chip)throw new Error('Existing pin differs from MCU ownership');
  const [config]=pins.resolver(binding.chipName).clone().resolve([`config_stepper oid=0 step_pin=${binding.pin} dir_pin=${binding.pin} invert_step=0 step_pulse_ticks=0`]);
  physical.add(`${binding.chipName}:${physicalStepPins(mcu.dictionary,config)[0]}`);
 }
 const plans=requests.map(request=>{
  const section=reader.section(request.section),stepText=section.get('step_pin'),directionText=section.get('dir_pin'),step=pins.parse(stepText,{canInvert:true}),direction=pins.parse(directionText,{canInvert:true}),mcu=mcus.get(step.chipName);
  if(!mcu||mcu.chip!==step.chip||direction.chipName!==step.chipName||direction.chip!==step.chip)throw new Error('Configured stepper pins differ from MCU ownership');
  const compiled=compileConfiguredStepper(reader,request.section,mcu.chip,mcu.dictionary,{oid:request.oid,step,direction,requestBothEdges:request.requestBothEdges},request.unitsInRadians??false),oidKey=`${step.chipName}:${request.oid}`;
  if(oids.has(oidKey))throw new Error('Duplicate configured stepper OID');oids.add(oidKey);
  let resolver=resolvers.get(step.chipName);if(!resolver){resolver=pins.resolver(step.chipName).clone();for(const [name,value] of Object.entries(mcu.dictionary.constants))if(name.startsWith('RESERVE_PINS_')){if(typeof value!=='string')throw new Error('Invalid firmware pin reservation');for(const pin of value.split(','))if(pin.trim())resolver.reserve(pin.trim(),name.slice(13));}resolvers.set(step.chipName,resolver);}
  for(const pin of resolver.reservedPins)reserved.add(`${step.chipName}:${physicalStepPins(mcu.dictionary,`config_stepper oid=0 step_pin=${pin} dir_pin=${pin} invert_step=0 step_pulse_ticks=0`)[0]}`);
  wireMaps.set(step.chipName,{pins:mcu.dictionary.pinEnumeration,reserved:resolver.reservedPins.map(pin=>physicalStepPins(mcu.dictionary,`config_stepper oid=0 step_pin=${pin} dir_pin=${pin} invert_step=0 step_pulse_ticks=0`)[0])});
  const [config,restart]=resolver.resolve([compiled.config,compiled.restart]);mcu.dictionary.encodeCommand(restart);
  // Config's first fields are tag, oid, step_pin and dir_pin. Decode wire IDs,
  // rather than comparing spellings: firmware may expose aliases for one GPIO.
  for(const pin of physicalStepPins(mcu.dictionary,config)){const key=`${step.chipName}:${pin}`;if(reserved.has(key))throw new Error('Firmware or machine reserved physical stepper pin');if(physical.has(key))throw new Error('Duplicate physical stepper pin');physical.add(key);}
  claims.push({description:stepText,options:{canInvert:true},exclusive:true},{description:directionText,options:{canInvert:true},exclusive:true});
  return Object.freeze({section:request.section,mcu:step.chipName,step,direction,...compiled,config,restart});
 });
 const acquired=pins.lookupBatch(claims,wireMaps);batchOwners.set(pins,{pins:physical,oids});return Object.freeze(plans.map((plan,i)=>Object.freeze({...plan,step:acquired[2*i],direction:acquired[2*i+1]})));
}
