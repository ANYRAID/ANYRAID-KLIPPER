import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {motanScalarDerivative,motanScalarCombine,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[3],p95:values[6]};};
for(const mode of ['float-array','float-buffer','integer']){
 const integer=mode==='integer';
 let first:MotanScalarSeries=Array.from({length:20000},(_,i)=>integer?(1n<<100n)+BigInt(i):i*.125);let second:MotanScalarSeries=Array.from({length:20000},(_,i)=>integer?(1n<<100n)-BigInt(i%7):(i%7)*.125);
 if(mode==='float-buffer'){first=Float64Array.from(first as number[]);second=Float64Array.from(second as number[]);}
 for(const kind of ['derivative','deviation','corexy_x','corexy_y'] as const){
  const reference=scalarOracle(kind,first,kind==='derivative'?undefined:second,.001,true),ms:number[]=[];let result:MotanScalarSeries=[];
  for(let i=0;i<9;i++){const start=performance.now();result=kind==='derivative'?motanScalarDerivative(first,.001):motanScalarCombine(first,second,kind);const elapsed=performance.now()-start;if(i>=2)ms.push(elapsed);}
  assert.deepEqual(scalarBits(result),reference.values);
  console.log(JSON.stringify({node:process.version,mode,kind,samples:first.length,historicalPythonMs:stats(reference.ms),nodeMs:stats(ms),exactTypesAndBits:true,referenceMode:"captured CPython; this run does not execute Python"}));
 }
}
