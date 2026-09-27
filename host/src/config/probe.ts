import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {ProbeSamples} from '../homing/probe-samples.ts';
export interface ProbeConfiguration {speed:number;offsets:readonly [number,number,number];sampling:Readonly<ProbeSamples>;}
/** Mechanical probe settings; no activation/deactivation macro execution. */
export function readProbeConfiguration(reader:ConfigurationReader):Readonly<ProbeConfiguration>|undefined{
 if(!reader.hasSection('probe'))return undefined;
 const p=reader.section('probe'),speed=p.getFloat('speed',{defaultValue:5,above:0}),result=p.get('samples_result',{defaultValue:'average'});
 if(result!=='average'&&result!=='median')throw new Error('Invalid probe samples_result');
 const sampling=Object.freeze({samples:p.getInt('samples',{defaultValue:1,minval:1,maxval:1000}),retractDistance:p.getFloat('sample_retract_dist',{defaultValue:2,above:0}),liftSpeed:p.getFloat('lift_speed',{defaultValue:speed,above:0}),tolerance:p.getFloat('samples_tolerance',{defaultValue:.1,minval:0}),retries:p.getInt('samples_tolerance_retries',{defaultValue:0,minval:0,maxval:100}),result});
 const offsets=Object.freeze([p.getFloat('x_offset',{defaultValue:0}),p.getFloat('y_offset',{defaultValue:0}),p.getFloat('z_offset')] as const);
 for(const option of ['activate_gcode','deactivate_gcode'])if(p.hasOption(option)&&p.get(option).trim())throw new Error('Probe activation macros require a typed device adapter');
 return Object.freeze({speed,offsets,sampling});
}
