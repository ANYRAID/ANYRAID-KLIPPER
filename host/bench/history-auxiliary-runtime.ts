import {performance} from 'node:perf_hooks';
import {mkdtemp,rm} from 'node:fs/promises';
import {statfsSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {DatabaseStore} from '../src/moonraker/database.ts';
import {HistoryRepository} from '../src/moonraker/history-repository.ts';
import {HistoryRuntime} from '../src/moonraker/history-runtime.ts';
import {HistoryTracker} from '../src/moonraker/history-tracker.ts';
const root=await mkdtemp(join(process.env.DATABASE_BENCH_ROOT??tmpdir(),'history-runtime-bench-')),db=await DatabaseStore.open({path:join(root,'db')});
const baseline=new URL('../node_modules/.cache/history-runtime-baseline-'+process.pid+'.mjs',import.meta.url);
const stats={filename:'part.gcode',total_duration:30,print_duration:25,filament_used:2.675};
const change=(event:'started'|'complete')=>({kind:'state' as const,event,previous:stats,current:stats});
const summarize=(values:number[])=>{const sorted=[...values].sort((a,b)=>a-b);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.ceil(sorted.length*.95)-1],roundsMs:values};};
try{
 const source=execFileSync('git',['show','e5e270f4:host/src/moonraker/history-runtime.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'});
 writeFileSync(baseline,stripTypeScriptTypes(source).replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,new URL('../src/moonraker/history-runtime.ts',import.meta.url)).href)));
 const Original=(await import(baseline.href)).HistoryRuntime;
 const repository=await HistoryRepository.open(db);await db.sealTableRegistration();
 let owned:HistoryTracker[]=[];
 const runtime=new HistoryRuntime(repository,{auxiliary:trackingEnabled=>{owned=Array.from({length:16},()=>new HistoryTracker({strategy:'accumulate',trackingEnabled}));return {reset(){for(const tracker of owned)tracker.reset();},snapshot(){return {data:owned.map((t,i)=>({provider:'sensor',name:String(i),value:t.value})),totals:owned.map((t,i)=>({provider:'sensor',field:String(i),value:t.value as number,report_total:true,report_maximum:true,precision:2}))};}};}});
 const raw=Array.from({length:16},()=>new HistoryTracker({strategy:'accumulate',trackingEnabled:()=>true}));
 const hot:Record<string,number[]>={direct:[],runtimeGate:[]};
 for(let round=0;round<13;round++){
  runtime.observe(change('started'));await runtime.drain();for(const t of raw)t.reset();
  for(const mode of round%2?['runtimeGate','direct']:['direct','runtimeGate']){const trackers=mode==='direct'?raw:owned,start=performance.now();for(let i=0;i<100000;i++)for(const t of trackers)t.update((i%128)/8);if(round>=2)hot[mode].push(performance.now()-start);}
  assert.deepEqual(owned.map(t=>t.value),raw.map(t=>t.value));runtime.observe(change('complete'));await runtime.drain();
 }
 const previous=new Original(repository),current=new HistoryRuntime(repository),boundaries:Record<string,number[]>={previous:[],current:[],current16Fields:[]};
 for(let round=0;round<7;round++)for(const mode of round%2?Object.keys(boundaries).reverse():Object.keys(boundaries)){
  const owner=mode==='previous'?previous:mode==='current'?current:runtime,start=performance.now();
  for(let i=0;i<100;i++){owner.observe(change('started'));if(mode==='current16Fields')for(const t of owned)t.update(2.675);owner.observe(change('complete'));await owner.drain();}
  if(round>=2)boundaries[mode].push(performance.now()-start);
 }
 await previous.close(stats);await current.close(stats);await runtime.close(stats);
 assert.equal((await repository.totals()).total_jobs,2113);
 console.log(JSON.stringify({node:process.version,baselineRuntime:'e5e270f4',filesystemMagic:statfsSync(root).type,hotUpdatesPerRound:1600000,hotWarmup:2,hotSamples:11,hot:Object.fromEntries(Object.entries(hot).map(([k,v])=>[k,summarize(v)])),jobsPerRound:100,boundaryWarmup:2,boundarySamples:5,boundaries:Object.fromEntries(Object.entries(boundaries).map(([k,v])=>[k,summarize(v)])),scope:'Synchronous samples and runtime job boundaries with real SQLite Worker; no physical printer'},null,2));
}finally{rmSync(baseline,{force:true});await db.close();await rm(root,{recursive:true,force:true});}
