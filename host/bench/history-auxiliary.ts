import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {writeFileSync,rmSync,statfsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository,type HistoryAuxiliarySnapshot} from '../src/moonraker/history-repository.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-aux-bench-')),db=await DatabaseStore.open({path:join(root,'db')});
const baseline=new URL('../node_modules/.cache/history-aux-baseline-'+process.pid+'.mjs',import.meta.url);
try{
 const source=execFileSync('git',['show','af5f00b3:host/src/moonraker/history-repository.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'});
 writeFileSync(baseline,stripTypeScriptTypes(source).replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,new URL('../src/moonraker/history-repository.ts',import.meta.url)).href)));
 const Original=(await import(baseline.href)).HistoryRepository;
 const history=await HistoryRepository.open(db),original=new Original(db);await db.sealTableRegistration();
 const reads:Record<string,number[]>={};
 async function readBench(modes:string[]){for(const mode of modes)reads[mode]=[];for(let round=0;round<7;round++)for(const mode of round%2?[...modes].reverse():modes){const start=performance.now();for(let i=0;i<500;i++){const result=mode==='previousEmpty'?{job_totals:await original.totals(),auxiliary_totals:[]}:await history.allTotals();assert.ok(JSON.stringify(result).length>10);}if(round>=2)reads[mode].push(performance.now()-start);}}
 await readBench(['previousEmpty','currentEmpty']);
 const stats={filename:'part.gcode',start_time:100,total_duration:30,print_duration:25,filament_used:2.675};
 const auxiliary:HistoryAuxiliarySnapshot={data:[],totals:Array.from({length:16},(_,i)=>({provider:'sensor',field:'field'+i,value:2.675,report_total:true,report_maximum:true,precision:2}))};
 auxiliary.data=auxiliary.totals.map(t=>({provider:t.provider,name:t.field,value:t.value,description:'Sensor reading',units:'J'}));
 const samples:Record<string,number[]>={previous:[],currentBase:[],current16Fields:[]};
 for(let round=0;round<7;round++)for(const mode of round%2?Object.keys(samples).reverse():Object.keys(samples)){
  const owner=mode==='previous'?original:history,start=performance.now();
  for(let i=0;i<100;i++){const job=await owner.start(stats);await owner.finish(job.job_id,'completed',stats,130,undefined,mode==='current16Fields'?auxiliary:undefined);}
  if(round>=2)samples[mode].push(performance.now()-start);
 }
 const totals=await history.allTotals();assert.equal(totals.job_totals.total_jobs,2100);assert.equal(totals.auxiliary_totals.length,16);
 await readBench(['current16Fields']);
 const summary=Object.fromEntries(Object.entries(samples).map(([mode,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [mode,{medianMs:sorted[2],p95Ms:sorted[4],roundsMs:values}];}));
 const readSummary=Object.fromEntries(Object.entries(reads).map(([mode,values])=>{const sorted=[...values].sort((a,b)=>a-b);return [mode,{medianMs:sorted[2],p95Ms:sorted[4],roundsMs:values}];}));
 console.log(JSON.stringify({node:process.version,baseline:'af5f00b3',filesystemMagic:statfsSync(root).type,jobsPerRound:100,readsPerRound:500,warmup:2,samples:5,summary,readSummary,scope:'Worker + SQLite synchronous FULL, start and finish and totals reads; no motion or real printer'},null,2));
}finally{rmSync(baseline,{force:true});await db.close();await rm(root,{recursive:true,force:true});}
