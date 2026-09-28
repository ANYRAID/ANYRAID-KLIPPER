import assert from 'node:assert/strict';
import {DeltaCalibration,fitDeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {DeltaCalibrationExecutor} from '../src/calibration/delta-calibration-executor.ts';
import {coordinateDescentReport} from '../src/math/mathutil.ts';
import {asymmetricDeltaCalibration} from '../test/helpers/delta-calibration.ts';
const input=asymmetricDeltaCalibration()[1],original=new DeltaCalibration(input.geometry),{adjustable,values}=original.parameters(true);
function legacy(){return coordinateDescentReport(adjustable,values,p=>{
 try{
  const cal=original.withParameters(p);let e=0;
  for(const h of input.probes)e+=(cal.position(h.stable)[2]-h.height)**2;
  e*=input.distances!.length/(.5*input.probes.length);
  for(const d of input.distances!){const a=cal.position(d.first),b=cal.position(d.second);e+=(Math.sqrt((a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2)-d.distance)**2;}
  return e;
 }catch(e){if(e instanceof RangeError)return 9999999999999.9;throw e;}
});}
const oldMs:number[]=[],newMs:number[]=[],workerMs:number[]=[],executor=new DeltaCalibrationExecutor();
let oldResult:ReturnType<typeof legacy>|undefined,newResult:ReturnType<typeof fitDeltaCalibration>|undefined;
for(let i=0;i<4;i++){
 for(const mode of i%2?['new','old']:['old','new']){
  const start=performance.now();if(mode==='old')oldResult=legacy();else newResult=fitDeltaCalibration(input);
  if(i)(mode==='old'?oldMs:newMs).push(performance.now()-start);
 }
 const start=performance.now(),result=await executor.fit(input);if(i)workerMs.push(performance.now()-start);
 assert(result.search.converged&&result.finalError<1e-18);
}
const median=(a:number[])=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const report={node:process.version,warmups:1,samples:3,oldMs,newMs,workerMs,oldMedianMs:median(oldMs),newMedianMs:median(newMs),workerMedianMs:median(workerMs),oldConverged:oldResult!.converged,newConverged:newResult!.search.converged,newError:newResult!.finalError,
 passed:newResult!.search.converged&&newResult!.finalError<1e-18&&median(newMs)<median(oldMs)&&median(workerMs)<median(oldMs),
 scope:'Alternating local Node26 extended calibration kernels, original coordinate descent vs SVD; separate worker startup included. Synthetic noiseless measurements only, no physical acceptance. Old result remains unconverged; this is runtime cost, not comparison of equally accurate solutions.'};
console.log(JSON.stringify(report,null,2));assert(report.passed);
