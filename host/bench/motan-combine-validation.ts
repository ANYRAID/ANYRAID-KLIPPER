import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {motanScalarCombine,type MotanScalarSeries} from '../src/motan/scalar-math.ts';
import {scalarOracle,scalarBits} from '../test/helpers/motan-scalar-oracle.ts';
const baselineCommit='ab6b31a9',directory=await mkdtemp(join(tmpdir(),'motan-combine-validation-'));
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
try{
 const derived=execFileSync('git',['show',baselineCommit+':host/src/motan/derived-math.ts'],{encoding:'utf8'}),scalar=execFileSync('git',['show',baselineCommit+':host/src/motan/scalar-math.ts'],{encoding:'utf8'}),table=execFileSync('git',['show',baselineCommit+':host/src/motan/table.ts']);
 assert.equal(sha(await readFile(new URL('../src/motan/table.ts',import.meta.url))),sha(table),'Shared budget dependency changed');
 const derivedPath=join(directory,'derived.mts'),scalarPath=join(directory,'scalar.mts');await writeFile(derivedPath,derived);await writeFile(scalarPath,scalar.replace("'./derived-math.ts'",JSON.stringify(pathToFileURL(derivedPath).href)).replace("'./table.ts'",JSON.stringify(new URL('../src/motan/table.ts',import.meta.url).href)));
 const old=await import(pathToFileURL(scalarPath).href),stats=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[15],p95Ms:values[29]};},results=[];
 for(const mode of ['float-array','float-buffer','integer','mixed','float-buffer-after-mixed','integer-after-mixed']){
  const floating=mode.startsWith('float'),base=1n<<100n;
  let first:MotanScalarSeries=floating?Array.from({length:20000},(_,i)=>i*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%2?Number(base)+i*.125:base+BigInt(i));
  let second:MotanScalarSeries=floating?Array.from({length:20000},(_,i)=>(i%7)*.125):Array.from({length:20000},(_,i)=>mode==='mixed'&&i%3===0?i*.25:base-BigInt(i%7));
  if(mode.startsWith('float-buffer')){first=Float64Array.from(first as number[]);second=Float64Array.from(second as number[]);}
  for(const kind of ['deviation','corexy_x','corexy_y'] as const){
   const reference=scalarOracle(kind,first,second,.001,true),runs=[()=>old.motanScalarCombine(first,second,kind,64*1024**2,true),()=>motanScalarCombine(first,second,kind,64*1024**2,true)],times:number[][]=[[],[]];
   for(const run of runs)assert.deepEqual(scalarBits(run()),reference.values);
   for(let run=0;run<61;run++)for(const variant of run%2?[1,0]:[0,1]){const begin=performance.now(),values=runs[variant](),elapsed=performance.now()-begin;if(run>=30)times[variant].push(elapsed);if(run===60)assert.deepEqual(scalarBits(values),reference.values);}
   const previous=stats(times[0]),current=stats(times[1]),ratio=current.medianMs/previous.medianMs;results.push({mode,kind,previous,current,ratio});
  }
 }
 console.log(JSON.stringify({node:process.version,baselineCommit,baselineHashes:{derived:sha(derived),scalar:sha(scalar),table:sha(table)},samples:20000,warmups:30,runs:31,alternatingOrder:true,results,scope:'Paired full-validation scalar combination kernels; original CPython type/bit checks before and after measurements. Captured Python only; no Python process or hardware motion.'},null,2));
 for(const row of results)assert(row.ratio<=1.15||row.current.medianMs-row.previous.medianMs<.05,JSON.stringify(row));
 const improvement=results.find(row=>row.mode==='float-array'&&row.kind==='deviation')!;assert(improvement.ratio<.8,'Array deviation must improve by at least 20% against the immediate baseline');
}finally{await rm(directory,{recursive:true,force:true});}
