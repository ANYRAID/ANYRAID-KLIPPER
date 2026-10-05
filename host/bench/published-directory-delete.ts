import assert from 'node:assert/strict';
import {mkdtemp,open,writeFile,rm,readdir,stat,statfs} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {monitorEventLoopDelay} from 'node:perf_hooks';
import {PublishedPrintFiles} from '../src/storage/published-files.ts';
const baselinePath=process.env.PUBLISHED_DELETE_BASELINE;if(!baselinePath)throw Error('Expected pre-delete store in PUBLISHED_DELETE_BASELINE');
const Baseline=(await import(pathToFileURL(baselinePath).href)).PublishedPrintFiles as typeof PublishedPrintFiles;
const dir=await mkdtemp(join(process.cwd(),'build/delete-bench-')),signal=new AbortController().signal,stores:PublishedPrintFiles[]=[];
const stats=(values:number[])=>{const v=[...values].sort((a,b)=>a-b);return {samples:v.length,medianMs:v[Math.floor(v.length*.5)],p95Ms:v[Math.floor(v.length*.95)],p99Ms:v[Math.floor(v.length*.99)],maxMs:v.at(-1)};};
try{
 await writeFile(join(dir,'source'),'G1 X1.000001\n');const input=await open(join(dir,'source'),'r');
 try{for(const [i,Store] of [Baseline,PublishedPrintFiles].entries()){const store=await Store.open(join(dir,'files-'+i),{maxPublishedFiles:2048});stores.push(store);await store.mutateDirectory('parts',false,signal);await store.mutateDirectory('parts/empty',false,signal);for(let n=0;n<1024;n++)await store.publish('f'+n,'part.gcode',input,signal,n<128?'parts/'+n+'.gcode':n+'.gcode');}}finally{await input.close();}
 const timings:number[][]=[[],[]];for(let run=0;run<14;run++)for(const index of run%2?[1,0]:[0,1]){const begin=performance.now();for(let n=0;n<50;n++)assert.equal((await stores[index].catalog(signal)).length,1024);if(run>=3)timings[index].push((performance.now()-begin)/50);}
 const baseline=stats(timings[0]),candidate=stats(timings[1]);assert(candidate.p99Ms<50);
 const store=stores[1],loop=monitorEventLoopDelay({resolution:1}),reads:number[]=[],durations:number[]=[],phaseCounts:number[]=[];loop.enable();await new Promise(r=>setTimeout(r,10));
 for(let run=0;run<8;run++){
  await store.copy(await store.prepareCopy('parts','delete-target',signal),signal);const begin=performance.now();let settled=false;
  const deletion=(async()=>store.deleteDirectory(await store.prepareDirectoryDelete('delete-target',signal),signal))().finally(()=>{settled=true;});let samples=0;
  while(!settled){const start=performance.now(),count=(await store.catalog(signal)).length;assert(count===1152||count===1024,'Read must be a complete pre/post deletion namespace');reads.push(performance.now()-start);samples++;await new Promise(r=>setTimeout(r,5));}
  await deletion;durations.push(performance.now()-begin);phaseCounts.push(samples);assert.equal(await store.hasDirectory('delete-target/empty',signal),false);assert.equal((await store.catalog(signal)).length,1024);
 }
 await new Promise(r=>setTimeout(r,10));loop.disable();const events={p99Ms:loop.percentile(99)/1e6,maxMs:loop.max/1e6};assert(stats(reads).p99Ms<50);assert(events.p99Ms<50);assert(events.maxMs<100);assert.equal(store.status.reservedBytes,0);assert.equal(store.filename('f0'),'parts/0.gcode');
 const root=join(dir,'files-1'),charged=(await Promise.all((await readdir(root)).map(async n=>(await stat(join(root,n))).size))).reduce((a,b)=>a+b,0);assert.equal(store.status.storedBytes,charged);await store.close();const reopened=await PublishedPrintFiles.open(root,{maxPublishedFiles:2048});stores[1]=reopened;assert.equal((await reopened.catalog(signal)).length,1024);assert.equal(reopened.status.storedBytes,charged);
 console.log(JSON.stringify({node:process.version,baselinePath,filesystemType:'0x'+(await statfs(dir,{bigint:true})).type.toString(16),files:1024,catalog:{baseline,candidate,medianRatio:candidate.medianMs/baseline.medianMs},recursiveDeletion:{operations:8,filesPerOperation:128,...stats(durations),catalogSamplesPerOperation:phaseCounts},concurrentCatalog:stats(reads),eventLoop:events,sharedBlobPreserved:true,reopened:true,chargedBytes:charged,scope:'Workspace disk fsync; original 50 ms query / 50-100 ms loop gates. Atomic cached reads include planning and durable commit. Not target-board, upstream speed parity, physical power-loss, motion precision or real print-duration proof.'}));
}finally{await Promise.all(stores.map(s=>s.close()));await rm(dir,{recursive:true,force:true});}
