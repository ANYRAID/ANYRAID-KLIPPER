import {captureHistoryMetadata} from '../src/moonraker/history-metadata.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryRuntime} from '../src/moonraker/history-runtime.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-runtime-bench-')),direct:number[]=[],queued:number[]=[],admission:number[]=[],delays:number[]=[];
const start={filename:'part.gcode',total_duration:0,print_duration:0,filament_used:0},finish={...start,total_duration:30,print_duration:25,filament_used:2.675};
const withMetadata=process.env.HISTORY_METADATA==='1',snapshot={generation:'mv-1',fields:{modified:99,notes:'x'.repeat(16384),print_start_time:1,job_id:'old',thumbnails:Array.from({length:8},(_,i)=>({relative_path:'thumb'+i+'.png',data:'x'.repeat(8192),size:8192}))}};
const withAttribution=process.env.HISTORY_ATTRIBUTION==='1',user=withAttribution?'alice':undefined,signal=new AbortController().signal;
const metadata=withMetadata?captureHistoryMetadata(snapshot).snapshot.fields:undefined;
try{
 for(let run=0;run<7;run++)for(const mode of run%2?['queued','direct']:['direct','queued']){
  const db=await DatabaseStore.open({path:join(root,mode+run)}),loop=monitorEventLoopDelay({resolution:1});
  try{
   const history=await HistoryRepository.open(db);await db.sealTableRegistration();const events:string[]=[];
   const runtime=new HistoryRuntime(history,{metadata:withMetadata?()=>snapshot:undefined,clock:()=>100,notify:event=>{events.push(event.action);}});
   loop.enable();const before=performance.now();
   if(mode==='direct'){for(let i=0;i<25;i++){const job=await history.start({...start,start_time:100,user,metadata});await history.finish(job.job_id,'completed',finish,100,metadata);}}
   else{for(let i=0;i<25;i++){const settle=withAttribution?runtime.beginPrint(start.filename,{username:user!},signal,signal):undefined;runtime.observe({kind:'state',event:'started',previous:finish,current:start});runtime.observe({kind:'state',event:'complete',previous:start,current:finish});settle?.(true);}if(run>=2)admission.push(performance.now()-before);await runtime.drain();}
   const elapsed=performance.now()-before;
   if(run>=2){(mode==='direct'?direct:queued).push(elapsed);if(mode==='queued')delays.push(loop.max/1e6);}
   if(withAttribution)assert.ok((await history.list({limit:25})).jobs.every(job=>job.user===user));if(withMetadata)assert.deepEqual((await history.get('1')).metadata,metadata);assert.equal((await history.totals()).total_jobs,25);assert.equal((await history.totals()).total_time,750);if(mode==='queued')assert.equal(events.length,50);await runtime.close(finish);
  }finally{loop.disable();await db.close();}
 }
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,withMetadata,withAttribution,filesystemMagic:statfsSync(root).type,directRepository:stats(direct),queuedRuntime:stats(queued),admit50Events:stats(admission),eventLoopMaxMs:Math.max(...delays),scope:'25 start/finish cycles, alternating order, WAL/FULL. Runtime snapshots 50 events synchronously, then drains bounded FIFO; notification callback records actions only. Excludes real file checks, WebSocket fanout, transport and hardware scheduling.'},null,2));
}finally{await rm(root,{recursive:true,force:true});}
