import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import {readStepperDistance} from './stepper.ts';
import {EndstopPhaseAlignment} from '../homing/endstop-phase.ts';
import type {TmcPhaseState} from '../drivers/tmc-phase.ts';
export interface ConfiguredEndstopPhase {readonly id:string;readonly alignment:EndstopPhaseAlignment;readonly offset:()=>number|null;}
/** Bind phase owners to actual configured emitters and initialized drivers. */
export function configureEndstopPhases(reader:ConfigurationReader,steppers:readonly {section:string;emitter:string}[],drivers:readonly {section:string;phase:TmcPhaseState}[]):readonly ConfiguredEndstopPhase[]{
 if(reader.hasSection('endstop_phase'))reader.section('endstop_phase');
 return Object.freeze(reader.prefixSections('endstop_phase ').map(name=>{
  const stepper=steppers.find(s=>s.section===name.slice('endstop_phase '.length));if(!stepper)throw new Error('Unknown endstop phase stepper');
  const section=reader.section(name),distance=readStepperDistance(reader.section(stepper.section)),trigger=section.getIntList('trigger_phase',{defaultValue:null,separator:'/',count:2}),accuracy=section.getFloat('endstop_accuracy',{defaultValue:null,above:0});
  const alignment=new EndstopPhaseAlignment({stepDistance:distance.stepDistance,microsteps:distance.microsteps,alignZero:section.getBoolean('endstop_align_zero',{defaultValue:false}),...(trigger?{triggerPhase:{phase:trigger[0],phases:trigger[1]}}:{}),...(accuracy===null?{}:{accuracy})});
  const driver=drivers.find(d=>d.section.slice(d.section.indexOf(' ')+1)===stepper.section);
  if(!driver&&reader.sections().some(s=>/^tmc\d+ /.test(s)&&s.slice(s.indexOf(' ')+1)===stepper.section))throw new Error('Endstop phase driver is not initialized');
  return Object.freeze({id:stepper.emitter,alignment,offset:()=>{if(!driver)return 0;const sample=driver.phase.sample;if(!sample||sample.phases!==alignment.status.phases)return null;return sample.offset;}});
 }));
}
