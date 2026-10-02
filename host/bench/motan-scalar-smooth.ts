import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {motanScalarSmooth,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {motanSmooth} from '../src/motan/derived-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
for(const mode of ['float-buffer','integer-53','integer-100','mixed'])for(const half of [5,25]){
 const base=1n<<BigInt(mode==='integer-53'?53:100),segment=.001,smooth=half*2*segment;
 const data:MotanScalarSeries=mode==='float-buffer'?Float64Array.from({length:20000},(_,i)=>i*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%3===1?i*.125:mode==='mixed'&&i%3===2?Boolean(i%2):base+BigInt(i));
 const reference=scalarOracle('smooth',data,undefined,segment,true,undefined,[String(smooth)]),ms:number[]=[],baseline:number[]=[];let result:Float64Array=new Float64Array();
 for(let run=0;run<35;run++)for(const variant of (run%2?['baseline','current']:['current','baseline'])){
  if(variant==='baseline'&&mode!=='float-buffer')continue;
  const start=performance.now(),value=variant==='current'?motanScalarSmooth(data,segment,smooth):motanSmooth(data as Float64Array,segment,smooth),elapsed=performance.now()-start;
  if(run>=20)(variant==='current'?ms:baseline).push(elapsed);result=value;
 }
 assert.deepEqual(scalarBits(result),reference.values);
 console.log(JSON.stringify({node:process.version,mode,halfWindow:half,samples:20000,historicalPythonMs:stats(reference.ms),nodeMs:stats(ms),numericBaselineMs:baseline.length?stats(baseline):undefined,exactTypesAndBits:true,referenceMode:"captured CPython; this run does not execute Python",warmups:{node:20,historicalPython:2},runs:{node:15,historicalPython:7},scope:'In-process smoothing including validation and output allocation; excludes process startup and source setup; no target printer proof.'}));
}
