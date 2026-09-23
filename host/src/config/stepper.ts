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
