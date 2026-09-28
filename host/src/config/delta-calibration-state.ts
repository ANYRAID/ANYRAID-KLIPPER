import {DeltaCalibration,type DeltaCalibrationInput,type DeltaHeightMeasurement,type DeltaDistanceMeasurement,type fitDeltaCalibration} from '../calibration/delta-calibration.ts';
import type {ConfigurationReader} from '../moonraker/config-reader.ts';
import type {SaveChange} from './klipper-save-changes.ts';
import type {Vec3} from '../math/mathutil.ts';

/** Restore saved physical observations, retaining full binary64 round-trip precision. */
export function readDeltaCalibrationState(reader:ConfigurationReader){
 const probes:DeltaHeightMeasurement[]=[],manual:DeltaHeightMeasurement[]=[],distances:DeltaDistanceMeasurement[]=[];
 if(!reader.hasSection('delta_calibrate'))return {probes,manual,distances};
 const section=reader.section('delta_calibrate'),seen=new Set<string>();
 const vector=(key:string):Vec3=>{seen.add(key);return section.getLists(key,{type:'float',separators:[','],count:[3]}) as unknown as Vec3;};
 for(const [prefix,target] of [['height',probes],['manual_height',manual]] as const){
  for(let i=0;i<999&&section.hasOption(prefix+i);i++){
   const key=prefix+i;seen.add(key);target.push({height:section.getFloat(key),stable:vector(key+'_pos')});
  }
 }
 for(let i=0;i<999&&section.hasOption('distance'+i);i++){
  const key='distance'+i;seen.add(key);distances.push({distance:section.getFloat(key,{above:0}),first:vector(key+'_pos1'),second:vector(key+'_pos2')});
 }
 // Missing indices/orphan vectors must not silently truncate stored measurements.
 for(const key of Object.keys(section.options()))if(/^(?:height|manual_height|distance)\d/.test(key)&&!seen.has(key))throw new Error('Noncontiguous or invalid Delta calibration observation: '+key);
 return {probes,manual,distances};
}

/** Prepare one atomic save batch; caller owns idle/state checks and durable save.
 * Saving does not activate geometry. Reinitialization and rehoming are required.
 */
export function deltaCalibrationSaveChanges(input:DeltaCalibrationInput,result:ReturnType<typeof fitDeltaCalibration>):SaveChange[]{
 const original=new DeltaCalibration(input.geometry),calibrated=new DeltaCalibration(result.geometry);
 if(!result.search.converged||!Number.isFinite(result.finalError)||result.finalError<0||result.finalError>result.initialError)throw new Error('Cannot save unsuccessful Delta calibration');
 if(calibrated.geometry.stepDistances.some((v,i)=>v!==original.geometry.stepDistances[i])||calibrated.geometry.angles[2]!==original.geometry.angles[2])throw new Error('Delta calibration changed fixed parameters');
 const changes:SaveChange[]=[{kind:'remove',section:'delta_calibrate'}];
 const set=(section:string,option:string,value:number|string)=>{if(typeof value==='number'&&!Number.isFinite(value))throw new RangeError('Nonfinite saved Delta value');changes.push({kind:'set',section,option,value:String(value)});};
 const vector=(value:Vec3)=>{if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))throw new RangeError('Invalid saved Delta stable position');return value.map(String).join(',');};
 set('printer','delta_radius',calibrated.geometry.radius);
 for(const [i,axis] of ['a','b','c'].entries()){
  const section='stepper_'+axis;set(section,'angle',calibrated.geometry.angles[i]);set(section,'arm_length',calibrated.geometry.arms[i]);set(section,'position_endstop',calibrated.geometry.endstops[i]);
 }
 for(const [prefix,observations] of [['height',input.probes],['manual_height',input.manual??[]]] as const){
  if(!Array.isArray(observations)||observations.length>999||prefix==='height'&&observations.length<3)throw new RangeError('Invalid saved Delta observation count');
  observations.forEach((p,i)=>{set('delta_calibrate',prefix+i,p.height);set('delta_calibrate',prefix+i+'_pos',vector(p.stable));});
 }
 const distances=input.distances??[];if(!Array.isArray(distances)||distances.length>999)throw new RangeError('Invalid saved Delta distance count');
 distances.forEach((p,i)=>{if(!(p.distance>0))throw new RangeError('Invalid saved Delta distance');set('delta_calibrate','distance'+i,p.distance);set('delta_calibrate','distance'+i+'_pos1',vector(p.first));set('delta_calibrate','distance'+i+'_pos2',vector(p.second));});
 return changes;
}
