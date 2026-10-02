import {statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'database-compact-bench-')),times:number[]=[],delays:number[]=[];let sizes:unknown;
try{
 for(let run=0;run<9;run++){
  const path=join(dir,`source-${run}.sqlite`);let store=await DatabaseStore.open({path});
  try{
   await store.insertBatch('ui',Object.fromEntries(Array.from({length:1000},(_,i)=>['key'+i,'x'.repeat(4096)])));await store.deleteBatch('ui',Array.from({length:900},(_,i)=>'key'+i));await store.close();store=await DatabaseStore.open({path});
   const loop=monitorEventLoopDelay({resolution:1});loop.enable();const begin=performance.now();const result=await store.compact() as {previous_size:number;new_size:number};const elapsed=performance.now()-begin;loop.disable();if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}sizes=result;assert.ok(result.new_size<result.previous_size);assert.equal(await store.get('ui','key999'),'x'.repeat(4096));
  }finally{await store.close();}
 }
 times.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(dir).type,filesystem:statfsSync(dir).type===0x01021994?'tmpfs':statfsSync(dir).type===0xef53?'ext-family':'other',benchmarkRoot:process.env.DATABASE_BENCH_ROOT??tmpdir(),inserted:1000,remaining:100,sizes,medianMs:times[3],p95Ms:times.at(-1),nodeEventLoopMaxMs:Math.max(...delays),scope:'VACUUM and WAL checkpoint in Worker, including IPC; local filesystem only, no Python latency equivalence or target hardware claim'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
