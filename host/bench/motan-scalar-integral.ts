import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {motanScalarIntegral,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {motanIntegral} from '../src/motan/derived-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
for(const mode of ['float-buffer','integer-53','integer-100','mixed'])for(const withReference of [false,true]){
 const base=1n<<BigInt(mode==='integer-53'?53:100),segment=.001,halfLife=.015;
 const data:MotanScalarSeries=mode==='float-buffer'?Float64Array.from({length:20000},(_,i)=>i*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%2?i*.125:base+BigInt(i));
 const reference:MotanScalarSeries|undefined=withReference?(mode==='float-buffer'?Float64Array.from({length:20000},(_,i)=>i*.01):Array.from({length:20000},(_,i)=>base+BigInt(Math.floor(i/3)))):undefined;
 const expected=scalarOracle('integral',data,reference,segment,true,undefined,reference?[String(halfLife)]:[]),ms:number[]=[],baseline:number[]=[];let result:Float64Array=new Float64Array();
 for(let run=0;run<35;run++)for(const variant of (run%2?['baseline','current']:['current','baseline'])){
  if(variant==='baseline'&&mode!=='float-buffer')continue;
  const start=performance.now(),value=variant==='current'?motanScalarIntegral(data,segment,reference,halfLife,64*1024**2,true):motanIntegral(data as Float64Array,segment,reference as Float64Array|undefined,halfLife),elapsed=performance.now()-start;
  if(run>=20)(variant==='current'?ms:baseline).push(elapsed);result=value;
 }
 assert.deepEqual(scalarBits(result),expected.values);
 console.log(JSON.stringify({node:process.version,mode,withReference,samples:20000,historicalPythonMs:stats(expected.ms),nodeMs:stats(ms),numericBaselineMs:baseline.length?stats(baseline):undefined,exactTypesAndBits:true,referenceMode:"captured CPython; this run does not execute Python",warmups:{node:20,historicalPython:2},runs:{node:15,historicalPython:7},scope:'Integral kernel including mean, validation and allocation; excludes startup/source setup; CPython 3.12 64-bit sum reference; no target printer proof.'}));
}
