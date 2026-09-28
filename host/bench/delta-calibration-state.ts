import assert from 'node:assert/strict';
import {deltaCalibrationSaveChanges} from '../src/config/delta-calibration-state.ts';
import {fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {asymmetricDeltaCalibration} from '../test/helpers/delta-calibration.ts';
const input=asymmetricDeltaCalibration()[1],fit=fitDeltaCalibration(input),samples:number[]=[];
for(let run=0;run<6;run++){
 const start=performance.now();for(let i=0;i<1000;i++)assert.equal(deltaCalibrationSaveChanges(input,fit).length,61);
 if(run)samples.push(performance.now()-start);
}
const medianMs=[...samples].sort((a,b)=>a-b)[2];
console.log(JSON.stringify({node:process.version,iterations:1000,warmups:1,samples,medianMs,scope:'Geometry and 19 observations serialized to save operations; excludes filesystem durability, worker fitting and physical printer. Diagnostic only; not on the print hot path.'},null,2));
