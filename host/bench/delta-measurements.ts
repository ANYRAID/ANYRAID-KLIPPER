import assert from 'node:assert/strict';
import {deltaObjectDistances} from '../src/calibration/delta-measurements.ts';
import {fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {measuredDeltaObject} from '../test/helpers/delta-object.ts';
const {input,measurements}=measuredDeltaObject(),conversionMs:number[]=[],fitMs:number[]=[];
let residual=0;
for(let run=0;run<6;run++){
 let start=performance.now();for(let i=0;i<1000;i++)assert.equal(deltaObjectDistances(measurements,input.geometry).length,12);if(run)conversionMs.push(performance.now()-start);
 start=performance.now();const result=fitDeltaCalibration({...input,distances:deltaObjectDistances(measurements,input.geometry)});if(run)fitMs.push(performance.now()-start);
 residual=Math.max(...result.heightResiduals.map(Math.abs),...result.distanceResiduals.map(Math.abs));assert(result.search.converged&&residual<1e-7);
}
const median=(v:number[])=>[...v].sort((a,b)=>a-b)[2];
const result={node:process.version,warmups:1,samples:5,conversionsPerSample:1000,conversionMs,fitMs,medianConversionMs:median(conversionMs),medianFitMs:median(fitMs),maxResidual:residual,passed:median(fitMs)<100&&median(conversionMs)<1000,scope:'Printed-object conversion and extended SVD fit on synthetic measurements. Cold calibration only; excludes Worker startup, IO, actual printed dimensions and physical accuracy.'};console.log(JSON.stringify(result,null,2));assert(result.passed);
