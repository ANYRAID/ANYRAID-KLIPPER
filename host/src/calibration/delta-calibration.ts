// Calibration geometry/objective derived from klippy/kinematics/delta.py and
// klippy/extras/delta_calibrate.py. GPL-3.0-or-later; Kevin O'Connor, 2017-2021.
import {trilateration,coordinateDescentReport,type Vec3} from '../math/mathutil.ts';
export interface DeltaCalibrationGeometry {radius:number;angles:Vec3;arms:Vec3;endstops:Vec3;stepDistances:Vec3;}
export interface DeltaHeightMeasurement {height:number;stable:Vec3;}
export interface DeltaDistanceMeasurement {distance:number;first:Vec3;second:Vec3;}
export interface DeltaCalibrationInput {geometry:DeltaCalibrationGeometry;probes:readonly DeltaHeightMeasurement[];manual?:readonly DeltaHeightMeasurement[];distances?:readonly DeltaDistanceMeasurement[];}
const axes=['a','b','c'] as const;
function triple(value:Vec3):Vec3{if(!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))throw new RangeError('Invalid Delta calibration triple');return Object.freeze([...value]) as Vec3;}
export class DeltaCalibration {
 readonly geometry:Readonly<DeltaCalibrationGeometry>;
 #towers:readonly Vec3[];#endstops:Vec3;#arm2:Vec3;
 constructor(input:DeltaCalibrationGeometry){
  const c=this.geometry=Object.freeze({...input,angles:triple(input.angles),arms:triple(input.arms),endstops:triple(input.endstops),stepDistances:triple(input.stepDistances)});
  if(!Number.isFinite(c.radius)||c.radius<=0||c.arms.some(a=>a<=c.radius)||c.stepDistances.some(s=>s<=0))throw new RangeError('Invalid Delta calibration geometry');
  this.#towers=c.angles.map(a=>{const angle=a*(Math.PI/180);return [Math.cos(angle)*c.radius,Math.sin(angle)*c.radius,0] as Vec3;});
  this.#arm2=triple(c.arms.map(a=>a*a) as unknown as Vec3);this.#endstops=triple(c.endstops.map((e,i)=>e+Math.sqrt(this.#arm2[i]-c.radius**2)) as unknown as Vec3);
  this.position([0,0,0]);
 }
 stable(position:Vec3):Vec3{
  const p=triple(position),c=this.geometry;
  return triple(this.#towers.map((t,i)=>(this.#endstops[i]-(Math.sqrt(this.#arm2[i]-(t[0]-p[0])**2-(t[1]-p[1])**2)+p[2]))/c.stepDistances[i]) as unknown as Vec3);
 }
 position(stable:Vec3):Vec3{
  const p=triple(stable),c=this.geometry;
  return trilateration(this.#towers.map((t,i)=>[t[0],t[1],this.#endstops[i]-p[i]*c.stepDistances[i]]) as unknown as [Vec3,Vec3,Vec3],this.#arm2);
 }
 parameters(extended=false){
  const values:Record<string,number>={radius:this.geometry.radius};
  for(const [i,a] of axes.entries()){values['angle_'+a]=this.geometry.angles[i];values['arm_'+a]=this.geometry.arms[i];values['endstop_'+a]=this.geometry.endstops[i];values['stepdist_'+a]=this.geometry.stepDistances[i];}
  return {adjustable:['radius','angle_a','angle_b','endstop_a','endstop_b','endstop_c',...(extended?['arm_a','arm_b','arm_c']:[])],values};
 }
 withParameters(p:Readonly<Record<string,number>>){const values=(prefix:string)=>axes.map(a=>p[prefix+a]) as unknown as Vec3;return new DeltaCalibration({radius:p.radius,angles:values('angle_'),arms:values('arm_'),endstops:values('endstop_'),stepDistances:values('stepdist_')});}
}
/** Synchronous numerical kernel for a worker. Does not apply or save geometry. */
export function fitDeltaCalibration(input:DeltaCalibrationInput){
 const original=new DeltaCalibration(input.geometry);
 if(!Array.isArray(input.probes)||input.probes.length<3||input.probes.length>999||input.manual!==undefined&&(!Array.isArray(input.manual)||input.manual.length>999)||input.distances!==undefined&&(!Array.isArray(input.distances)||input.distances.length>999))throw new RangeError('Invalid Delta calibration measurement count');
 const heights=[...input.manual??[],...input.probes].map(p=>{if(!Number.isFinite(p.height))throw new RangeError('Invalid probe height');return {height:p.height,stable:triple(p.stable)};});
 const distances=(input.distances??[]).map(p=>{if(!Number.isFinite(p.distance)||p.distance<=0)throw new RangeError('Invalid calibration distance');return {distance:p.distance,first:triple(p.first),second:triple(p.second)};});
 const weight=distances.length?distances.length/(.5*input.probes.length):1;
 const error=(cal:DeltaCalibration)=>{
  let total=0;for(const h of heights)total+=(cal.position(h.stable)[2]-h.height)**2;total*=weight;
  for(const d of distances){const a=cal.position(d.first),b=cal.position(d.second);total+=(Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2)-d.distance)**2;}
  if(!Number.isFinite(total))throw new RangeError('Nonfinite Delta calibration error');return total;
 };
 const initialError=error(original),{adjustable,values}=original.parameters(distances.length>0);
 const search=coordinateDescentReport(adjustable,values,p=>{try{return error(original.withParameters(p));}catch(e){if(e instanceof RangeError)return 9999999999999.9;throw e;}});
 const calibrated=original.withParameters(search.parameters),finalError=error(calibrated);
 if(finalError>initialError)throw new Error('Delta calibration did not improve');
 return {search,geometry:calibrated.geometry,initialError,finalError,heightResiduals:heights.map(h=>calibrated.position(h.stable)[2]-h.height),distanceResiduals:distances.map(d=>{const a=calibrated.position(d.first),b=calibrated.position(d.second);return Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2)-d.distance;})};
}
