import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {motanScalarNorm2,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {motanNorm2} from '../src/motan/derived-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
for(const mode of ['float-buffer','integer-53','integer-100','mixed'])for(const axes of [2,3]){
 const series:MotanScalarSeries[]=Array.from({length:axes},(_,axis)=>{
  if(mode==='float-buffer')return Float64Array.from({length:20000},(_,i)=>(i+axis)*.125);
  const base=1n<<BigInt(mode==='integer-53'?53:100);
  return Array.from({length:20000},(_,i)=>mode==='mixed'&&axis===1?i*.125:mode==='mixed'&&axis===2?Boolean(i%2):base+BigInt(i+axis));
 });
 const reference=scalarOracle('norm2',series[0],series[1],.001,true,series[2]),ms:number[]=[],baseline:number[]=[];let result:Float64Array=new Float64Array();
 for(let run=0;run<35;run++)for(const variant of (run%2?['baseline','current']:['current','baseline'])){
  if(variant==='baseline'&&mode!=='float-buffer')continue;
  const start=performance.now(),value=variant==='current'?motanScalarNorm2(series):motanNorm2(series as Float64Array[]),elapsed=performance.now()-start;
  if(run>=20)(variant==='current'?ms:baseline).push(elapsed);result=value;
 }
 assert.deepEqual(scalarBits(result),reference.values);
 const numericBaseline=baseline.length?stats(baseline):undefined;
 console.log(JSON.stringify({node:process.version,mode,axes,samples:20000,pythonMs:stats(reference.ms),nodeMs:stats(ms),numericBaselineMs:numericBaseline,exactTypesAndBits:true,warmups:{node:20,python:2},runs:{node:15,python:7},scope:'In-process norm kernel; includes validation and output allocation, excludes process startup and source setup; no target printer proof.'}));
}
