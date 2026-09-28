import {DeltaCalibration} from '../../src/calibration/delta-calibration.ts';
import {deltaObjectDistances} from '../../src/calibration/delta-measurements.ts';
import {asymmetricDeltaCalibration} from './delta-calibration.ts';
export function measuredDeltaObject(){
 const input=asymmetricDeltaCalibration()[0],truth=new DeltaCalibration({...input.geometry,radius:100.2,endstops:[300.1,300.1,300.1]});
 const measurements={scale:1,centerDistances:Array(6).fill(70),centerWidths:[4,5,6],outerDistances:Array(6).fill(70),outerWidths:[4,5,6,7,8,9]};
 const distances=deltaObjectDistances(measurements,input.geometry);
 const physical=distances.map(d=>{const a=truth.position(d.first),b=truth.position(d.second);return Math.hypot(...a.map((v,i)=>v-b[i]));});
 measurements.centerDistances=physical.slice(0,6).map((d,i)=>d+measurements.centerWidths[[0,2,1,0,2,1][i]]);measurements.outerDistances=physical.slice(6).map((d,i)=>d+measurements.outerWidths[i]);
 return {input,truth,measurements};
}
