import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {MetadataScanIntents,type MetadataScanIntent} from '../src/moonraker/metadata-intents.ts';
import {MetadataVersions,type MetadataVersion} from '../src/moonraker/metadata-versions.ts';
const signal=new AbortController().signal,dir=await mkdtemp(join(tmpdir(),'version-bench-')),stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
let versions:MetadataVersions|undefined,intents:MetadataScanIntents|undefined;
try{
 versions=await MetadataVersions.open(join(dir,'versions'));intents=await MetadataScanIntents.open(join(dir,'intents'));for(let i=0;i<1024;i++)await versions.invalidate(`file-${i}.gcode`,signal);
 await versions.close();const opened=performance.now();versions=await MetadataVersions.open(join(dir,'versions'));const recoveryMs=performance.now()-opened;
 const printPath=join(dir,'read.bin');await writeFile(printPath,Buffer.alloc(65536));const loop=monitorEventLoopDelay({resolution:1}),reads:number[]=[],begins:number[]=[],selects:number[]=[],invalidations:number[]=[];let stop=false,reader:Promise<void>|undefined;
 try{for(let i=0;i<16;i++){
  if(i===5){loop.enable();reader=(async()=>{while(!stop){const at=performance.now();await readFile(printPath);reads.push(performance.now()-at);}})();}
  const intent:MetadataScanIntent=await intents.begin('file-0.gcode',signal);let at=performance.now();const pending:MetadataVersion=await versions.begin(intent,signal);if(i>=5)begins.push(performance.now()-at);at=performance.now();const selected:MetadataVersion|null=await versions.select(pending,signal);if(i>=5)selects.push(performance.now()-at);assert.equal(selected?.scanId,intent.id);at=performance.now();await versions.invalidate(intent.filename,signal);if(i>=5)invalidations.push(performance.now()-at);await intents.acknowledge(intent,signal);
 }}finally{stop=true;await reader;loop.disable();}
 const queries:number[]=[];for(let i=0;i<16;i++){const at=performance.now();for(let n=0;n<10000;n++)assert.equal(versions.current(`file-${n%1024}.gcode`)?.state,'invalidated');if(i>=5)queries.push(performance.now()-at);}
 assert.equal(versions.entries().length,1024);console.log(JSON.stringify({node:process.version,files:1024,recoveryMs,warmups:5,runs:11,beginWithCompaction:stats(begins),selectWithCompaction:stats(selects),invalidateWithCompaction:stats(invalidations),currentQueries10000:stats(queries),parentRead64KiB:stats(reads),parentEventLoop:{p95Ms:loop.percentile(95)/1e6,maxMs:loop.max/1e6},scope:'Actual version-event publication and old-event removal with fsync; intent work excluded from individual operation latency but included in read/loop probes. Recovery reads 1024 events. Query timing has no background read probe. No Python or target-board print equivalence.'},null,2));
}finally{await versions?.close();await intents?.close();await rm(dir,{recursive:true,force:true});}
