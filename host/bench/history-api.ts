import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {registerHistory} from '../src/moonraker/history-api.ts';
import {EndpointRegistry} from '../src/moonraker/endpoints.ts';
import {JsonRpcDispatcher,type RpcContext} from '../src/moonraker/rpc.ts';
import {historyBenchmarkReference} from '../test/helpers/history-reference.ts';
const runs=7,warmup=2,listsPerRun=50,params={limit:50,start:50},rows=Array.from({length:200},(_,i)=>({id:i+1,start:100+i,end:200+i}));
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-api-bench-')),times:number[]=[],delays:number[]=[];
const db=await DatabaseStore.open({path:join(root,'db')});
try{
 const history=await HistoryRepository.open(db);await db.sealTableRegistration();
 await db.sql(['job_history'],[{sql:"INSERT INTO job_history VALUES(?,'No User','part.gcode','completed',?,?,1,2,2.675,'{}','[]','default')",many:rows.map(row=>[row.id,row.start,row.end])}]);
 const registry=new EndpointRegistry(new JsonRpcDispatcher()),release=registerHistory(registry,{repository:history,fileExists:()=>false}),context:RpcContext={transport:'http',signal:new AbortController().signal,authorize(){}};
 try{
  for(let run=0;run<runs;run++){
   const loop=monitorEventLoopDelay({resolution:1});loop.enable();const start=performance.now();
   try{for(let i=0;i<listsPerRun;i++){const result=await registry.invoke('/server/history/list','GET',params,context) as any;assert.equal(result.count,50);assert.equal(result.jobs[0].job_id,'000096');assert.equal(result.jobs[49].job_id,'000065');}if(run>=warmup){times.push(performance.now()-start);delays.push(loop.max/1e6);}}finally{loop.disable();}
  }
 }finally{release();}
 const historical=historyBenchmarkReference<number[]>('history-api-benchmark',JSON.stringify({rows,runs,warmup,listsPerRun,params,journalMode:'WAL',synchronous:'FULL'}));
 const stats=(a:number[])=>{a.sort((a,b)=>a-b);return {medianMs:a[2],p95Ms:a.at(-1)};};
 console.log(JSON.stringify({node:process.version,filesystemMagic:statfsSync(root).type,nodeEndpoint:stats(times),pythonHistorical:{...historical,result:stats(historical.result)},eventLoopMaxMs:Math.max(...delays),scope:'50 paginated lists of 50 rows from 200 rows. Historical Python capture uses the same original WAL/FULL workload; current run executes Node only. Node Worker+endpoint; pinned Python handler direct async adapter, omits provider thread. Original file-existence checks return false without I/O. Not HTTP, filesystem checking or print-speed acceptance.'},null,2));
}finally{await db.close();await rm(root,{recursive:true,force:true});}
