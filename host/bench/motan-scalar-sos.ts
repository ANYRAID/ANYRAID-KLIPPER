import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {motanScalarSOSFilter,type MotanSOS} from '../src/motan/sos-filter.ts';
import type {MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
import {scalarSOSOracle} from '../test/helpers/motan-scalar-sos-oracle.ts';
const stats=(values:number[])=>{values.sort((a,b)=>a-b);return {median:values[Math.floor(values.length/2)],p95:values[Math.ceil(values.length*.95)-1]};};
const sos:MotanSOS=[[.5,.5,0,1,0,0],[.25,.5,.25,1,0,0]],dir=await mkdtemp(join(tmpdir(),'motan-scalar-sos-bench-'));
try{
 const origin=new URL('../src/motan/sos-filter.ts',import.meta.url),path=join(dir,'baseline.mts');
 await writeFile(path,execFileSync('git',['show','8903c16d:host/src/motan/sos-filter.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(whole,spec:string)=>spec.startsWith('.')?`from '${new URL(spec,origin).href}'`:whole));
 const baselineFilter=(await import(pathToFileURL(path).href)).motanSOSFilter;
 for(const kind of ['float-buffer','integer-53','int64-boundary','uint64','boolean','mixed','float-after-scalars'])for(const mode of ['filt','filtfilt'] as const){
  const floating=kind.startsWith('float');
  const source:MotanScalarSeries=floating?Float64Array.from({length:20000},(_,i)=>i*.125):Array.from({length:20000},(_,i)=>kind==='boolean'?Boolean(i%2):kind==='int64-boundary'?(i%2?-(1n<<63n):(1n<<63n)-1n):kind==='uint64'?(1n<<64n)-1n-BigInt(i):kind==='mixed'&&i%2?i*.125:(1n<<53n)+BigInt(i));
  const reference=scalarSOSOracle(source,sos,mode,true);assert.equal(reference.error,undefined);
  const ms:number[]=[],old:number[]=[];let result:Float64Array=new Float64Array();
  for(let run=0;run<35;run++)for(const variant of (run%2?['baseline','current']:['current','baseline'])){
   if(variant==='baseline'&&!floating)continue;
   const start=performance.now(),value=variant==='current'?motanScalarSOSFilter(sos,source,mode,64*1024**2,true):baselineFilter(sos,source,mode),elapsed=performance.now()-start;
   if(run>=20)(variant==='current'?ms:old).push(elapsed);result=value;
  }
  assert.deepEqual(scalarBits(result).map(([,bits])=>bits),reference.bits);
  console.log(JSON.stringify({node:process.version,kind,mode,dtype:reference.dtype,samples:source.length,capturedScipyMs:stats(reference.ms!),nodeMs:stats(ms),previousNumericMs:old.length?stats(old):undefined,exactBits:true,warmups:{node:20,capturedScipy:2},runs:{node:15,capturedScipy:7},scope:'Two fixed dyadic sections; includes input inference/conversion, initialization, padding and filtering. Excludes coefficient design, startup and source setup. Previous numeric kernel pinned to 8903c16d. SciPy timing is a fixed independent Linux x64 capture, not a current run; no target printer proof.'}));
 }
}finally{await rm(dir,{recursive:true,force:true});}
