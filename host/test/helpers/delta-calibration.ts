import {DeltaCalibration,type DeltaCalibrationInput} from '../../src/calibration/delta-calibration.ts';
import type {Vec3} from '../../src/math/mathutil.ts';
export function asymmetricDeltaCalibration(){
const geometry={radius:100,angles:[210,330,90] as Vec3,arms:[250,251,250.5] as Vec3,endstops:[300,300.2,299.9] as Vec3,stepDistances:[.0125,.00625,.0125] as Vec3},original=new DeltaCalibration(geometry),truth=new DeltaCalibration({...geometry,radius:100.2,endstops:[300.1,300.1,300.1]});
const points=Array.from({length:7},(_,i)=>{const angle=i*Math.PI/3;return original.stable(i?[Math.cos(angle)*65,Math.sin(angle)*65,0]:[0,0,0]);}),probes=points.map(stable=>({stable,height:truth.position(stable)[2]}));
const distances=Array.from({length:12},(_,i)=>{const first=points[1+i%6],second=points[1+(i+2)%6],a=truth.position(first),b=truth.position(second);return {first,second,distance:Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2)};});
const cases:DeltaCalibrationInput[]=[{geometry,probes},{geometry,probes,distances}];
return cases;
}
