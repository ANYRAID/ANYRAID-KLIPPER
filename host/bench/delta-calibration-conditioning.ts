// Offline solver experiment only: never applies geometry to a printer.
import assert from 'node:assert/strict';
import {Matrix,SingularValueDecomposition} from 'ml-matrix';
import {DeltaCalibration} from '../src/calibration/delta-calibration.ts';
import {asymmetricDeltaCalibration} from '../test/helpers/delta-calibration.ts';
import type {Vec3} from '../src/math/mathutil.ts';

const input=asymmetricDeltaCalibration()[1],original=new DeltaCalibration(input.geometry);
const {adjustable,values}=original.parameters(true);
const truth=new DeltaCalibration({...input.geometry,radius:100.2,endstops:[300.1,300.1,300.1]});
const weight=Math.sqrt(input.distances!.length/(.5*input.probes.length));
function residuals(parameters:Record<string,number>){
 const cal=original.withParameters(parameters);
 return [...input.probes.map(p=>(cal.position(p.stable)[2]-p.height)*weight),...input.distances!.map(d=>{
  const a=cal.position(d.first),b=cal.position(d.second);
  return Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])-d.distance;
 })];
}
const norm=(r:number[])=>r.reduce((s,v)=>s+v*v,0);
function jacobian(p:Record<string,number>,h:number){
 const columns=adjustable.map(key=>{
  const a=residuals({...p,[key]:p[key]+h}),b=residuals({...p,[key]:p[key]-h});
  return a.map((v,i)=>(v-b[i])/(2*h));
 });
 return new Matrix(columns).transpose();
}
function spectrum(p:Record<string,number>,h:number){
 const svd=new SingularValueDecomposition(jacobian(p,h));
 return {h,singularValues:svd.diagonal,rank:svd.rank,condition:svd.condition};
}
function solve(h:number){
 let p={...values},error=norm(residuals(p)),iterations=0;
 const start=performance.now();
 for(;iterations<30&&error>1e-20;iterations++){
  const r=residuals(p),j=jacobian(p,h);
  const step=new SingularValueDecomposition(j).solve(Matrix.columnVector(r.map(v=>-v))).to1DArray();
  let accepted=false;
  for(let scale=1;scale>=2**-20;scale/=2){
   const candidate={...p};adjustable.forEach((key,i)=>candidate[key]+=scale*step[i]);
   let next=Infinity;
   try{next=norm(residuals(candidate));}catch(e){if(!(e instanceof RangeError))throw e;}
   if(next<error){p=candidate;error=next;accepted=true;break;}
  }
  if(!accepted)break;
 }
 const ms=performance.now()-start,cal=original.withParameters(p);
 // Independent positions at several heights, not used in fitting.
 let maxHeldOutPositionError=0;
 for(const z of [0,25,100])for(const radius of [0,20,50])for(let i=0;i<8;i++){
  const point:Vec3=[radius*Math.cos(i*Math.PI/4),radius*Math.sin(i*Math.PI/4),z];
  const stable=original.stable(point),a=cal.position(stable),b=truth.position(stable);
  maxHeldOutPositionError=Math.max(maxHeldOutPositionError,...a.map((v,i)=>Math.abs(v-b[i])));
 }
 const expected=truth.parameters(true).values;
 return {h,iterations,ms,error,maxHeldOutPositionError,maxParameterError:Math.max(...adjustable.map(k=>Math.abs(p[k]-expected[k]))),parameters:p};
}
const steps=[1e-2,1e-3,1e-4,1e-5],spectra=steps.map(h=>spectrum(values,h));
solve(1e-3); // Warm the experiment before collecting timings.
const results=steps.map(solve);
const report={node:process.version,library:'ml-matrix',rows:19,parameters:9,uniqueDistances:new Set(input.distances!.map(d=>JSON.stringify([d.first,d.second]))).size,spectra,results,
 scope:'Synthetic noiseless local identifiability and SVD Gauss-Newton experiment. Millimetre/degree parameter units; condition number depends on scaling. No production solver, noisy-data acceptance, physical tolerance or stable speed claim.'};
console.log(JSON.stringify(report,null,2));
assert(spectra.every(s=>s.rank===9));
assert(results.every(r=>r.error<1e-18&&r.maxHeldOutPositionError<1e-7&&r.maxParameterError<1e-7));
