import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {historyBenchmarkReference} from '../test/helpers/history-reference.ts';
const runs=7,warmup=2,cycles=25;
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-bench-')),times:number[]=[],delays:number[]=[];
const data={filename:'part.gcode',start_time:100,total_duration:30,print_duration:25,filament_used:2.675,metadata:{size:1000},auxiliary_data:[]};
try{
 for(let run=0;run<runs;run++){
  const db=await DatabaseStore.open({path:join(root,'node'+run)}),loop=monitorEventLoopDelay({resolution:1});
  try{
   const history=await HistoryRepository.open(db);await db.sealTableRegistration();loop.enable();const start=performance.now();
   for(let i=0;i<cycles;i++){const job=await history.start(data);await history.finish(job.job_id,'completed',data,130);}
   const elapsed=performance.now()-start;if(run>=warmup){times.push(elapsed);delays.push(loop.max/1e6);}
   assert.equal((await history.totals()).total_jobs,25);assert.equal((await history.totals()).total_time,750);assert.equal((await history.list({limit:0})).count,25);
  }finally{loop.disable();await db.close();}
 }
 const historical=historyBenchmarkReference<number[]>('history-repository-benchmark',JSON.stringify({runs,warmup,cycles,data,journalMode:'WAL',synchronous:'FULL'}));
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,nodeWorker:stats(times),pythonHistorical:{...historical,result:stats(historical.result)},eventLoopMaxMs:Math.max(...delays),scope:'25 start/finish/total cycles, WAL/FULL, excludes setup and final assertions. Node atomic finish/totals, upstream separate transactions. Historical Python capture only; current run executes Node only. Original Python methods grouped per job in one thread, async loop per cycle. No file metadata or notifications; not full server or print-speed evidence.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
