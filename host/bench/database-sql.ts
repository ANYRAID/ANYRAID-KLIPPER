import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {databaseBenchmarkReference} from '../test/helpers/database-reference.ts';
const dir=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'sql-bench-')),times:number[]=[],delays:number[]=[];
try{
 for(let run=0;run<7;run++){
  const store=await DatabaseStore.open({path:join(dir,'node'+run)}),loop=monitorEventLoopDelay({resolution:1});
  try{
   await store.registerTable({name:'jobs',prototype:'jobs (id INTEGER PRIMARY KEY,value REAL)',version:1});await store.sealTableRegistration();
   const operations=process.env.SQL_MANY==='1'?[{sql:'INSERT OR REPLACE INTO jobs VALUES(?,?)',many:Array.from({length:100},(_,i)=>[i,2.675])}]:Array.from({length:100},(_,i)=>({sql:'INSERT OR REPLACE INTO jobs VALUES(?,?)',params:[i,2.675]}));
   loop.enable();const start=performance.now();
   for(let batch=0;batch<20;batch++){
    const results=await store.sql(['jobs'],[...operations,{sql:'SELECT * FROM jobs ORDER BY id'}]);assert.equal(results.length,operations.length+1);assert.equal(results.at(-1)!.rows.length,100);assert.deepEqual(results.at(-1)!.rows[99],[99,2.675]);
   }
   const elapsed=performance.now()-start;if(run>=2){times.push(elapsed);delays.push(loop.max/1e6);}
  }finally{loop.disable();await store.close();}
 }
 const historical=databaseBenchmarkReference('database-sql',JSON.stringify({many:process.env.SQL_MANY==='1'}));
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,many:process.env.SQL_MANY==='1',filesystemMagic:statfsSync(dir).type,nodeWorker:stats(times),pythonThread:historical?stats([...historical.samplesMs]):null,eventLoopMaxMs:Math.max(...delays),historicalPythonReference:historical,nodeSamplesMs:[...times],scope:'Historical Python timings are frozen and may use another filesystem/environment; current Node measurements and original assertions remain. 20 transactions of 100 upserts and 100-row read, WAL/FULL. Python pinned SQL methods grouped into one thread call, omitting individual cursor/future round trips and write acknowledgements; optimistic baseline, not full server or hardware.'},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
