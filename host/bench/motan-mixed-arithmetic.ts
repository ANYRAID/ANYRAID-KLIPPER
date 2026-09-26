import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {motanScalarDerivative,motanScalarCombine,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
const dir=await mkdtemp(join(tmpdir(),'motan-mixed-bench-'));
try{
 const path=join(dir,'baseline.mts'),origin=new URL('../src/motan/scalar-math.ts',import.meta.url);
 await writeFile(path,execFileSync('git',['show','25129874:host/src/motan/scalar-math.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(whole,spec:string)=>spec.startsWith('.')?`from '${new URL(spec,origin).href}'`:whole));
 const baseline=await import(pathToFileURL(path).href);
 for(const mode of ['float-buffer','integer','mixed','float-after-mixed','integer-after-mixed']){
  const base=1n<<100n,floating=mode.startsWith('float');
  const first:MotanScalarSeries=floating?Float64Array.from({length:20000},(_,i)=>i*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%2?Number(base)+i*.125:base+BigInt(i));
  const second:MotanScalarSeries=floating?Float64Array.from({length:20000},(_,i)=>(i%7)*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%3===0?i*.25:base-BigInt(i%7));
  for(const kind of ['derivative','deviation','corexy_x','corexy_y'] as const){
   const reference=scalarOracle(kind,first,kind==='derivative'?undefined:second,.001,true),ms:number[]=[],old:number[]=[];let result:MotanScalarSeries=[];
   for(let run=0;run<35;run++)for(const variant of (run%2?['baseline','current']:['current','baseline'])){
    if(variant==='baseline'&&mode==='mixed')continue;
    const start=performance.now();result=variant==='current'?(kind==='derivative'?motanScalarDerivative(first,.001,true):motanScalarCombine(first,second,kind,64*1024**2,true)):(kind==='derivative'?baseline.motanScalarDerivative(first,.001):baseline.motanScalarCombine(first,second,kind));
    const elapsed=performance.now()-start;if(run>=20)(variant==='current'?ms:old).push(elapsed);
   }
   assert.deepEqual(scalarBits(result),reference.values);
   const current=kind==='derivative'?motanScalarDerivative(first,.001,true):motanScalarCombine(first,second,kind,64*1024**2,true);
   assert.deepEqual(scalarBits(current),reference.values);
   console.log(JSON.stringify({node:process.version,mode,kind,samples:20000,historicalPythonMs:stats(reference.ms),nodeMs:stats(ms),previousMs:old.length?stats(old):undefined,exactTypesAndBits:true,referenceMode:"captured CPython; this run does not execute Python",warmups:{node:20,historicalPython:2},runs:{node:15,historicalPython:7},scope:'Scalar kernels with validation and result budgeting/allocation. Previous implementation pinned to 25129874 for previously supported inputs. Excludes startup/source setup; no target printer proof.'}));
  }
 }
}finally{await rm(dir,{recursive:true,force:true});}
