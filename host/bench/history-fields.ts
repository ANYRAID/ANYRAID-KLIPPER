import {performance} from 'node:perf_hooks';
import {execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {HistoryTracker,historyStrategies} from '../src/moonraker/history-tracker.ts';
import {historyReference} from '../test/helpers/history-reference.ts';
const input={strategies:[...historyStrategies],updatesPerRound:100000,snapshotsPerRound:1000,fields:16,rounds:9,warmup:2};
const {updatesPerRound,snapshotsPerRound,fields:fieldCount,rounds,warmup}=input;
type BenchReference=Record<'fixed'|'changing',{samples:number[];result:unknown}>&{integerDelta:number[]};
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
const baseline=new URL('../node_modules/.cache/history-tracker-fields-baseline-'+process.pid+'.mjs',import.meta.url);
try{
 const source=execFileSync('git',['show','255bb601:host/src/moonraker/history-tracker.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'});writeFileSync(baseline,stripTypeScriptTypes(source).replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,new URL('../src/moonraker/history-tracker.ts',import.meta.url)).href)));
 const Original=(await import(baseline.href)).HistoryTracker,updates=[];
 for(const strategy of historyStrategies){let expected:unknown;const samples:Record<string,number[]>={previous:[],current:[]};for(let run=0;run<rounds;run++)for(const mode of run%2?['current','previous']:['previous','current']){let paused=false;const Tracker=mode==='current'?HistoryTracker:Original,t=new Tracker({strategy,excludePaused:true,trackingEnabled:(exclude:boolean)=>!(exclude&&paused)});t.reset();const start=performance.now();for(let i=0;i<updatesPerRound;i++){paused=i%10===0;t.update((i%128)/8);}if(run>=warmup)samples[mode].push(performance.now()-start);if(expected===undefined)expected=t.value;else assert.deepEqual(t.value,expected);}updates.push({strategy,previous:summary(samples.previous),current:summary(samples.current)});}
 const reference=historyReference<BenchReference>('history-fields-benchmark',JSON.stringify(input));
 const snapshots=[];
 for(const mode of ['fixed','changing'] as const){const fields=new HistoryFields(()=>true),registered=Array.from({length:fieldCount},(_,i)=>fields.register({provider:'sensor',name:String(i),description:'Reading',strategy:'basic',units:'J',reportTotal:true,reportMaximum:true,precision:2}));const times=[];for(let run=0;run<rounds;run++){for(const field of registered)field.tracker.update(2.675);const start=performance.now();let result;for(let i=0;i<snapshotsPerRound;i++){if(mode==='changing')for(const field of registered)field.tracker.update(i/8);result=fields.snapshot();JSON.stringify(result);}if(run>=warmup)times.push(performance.now()-start);assert.deepEqual(result,reference[mode].result);}snapshots.push({mode,node:summary(times),capturedPython:summary(reference[mode].samples)});}
 const integerSamples=[];for(let run=0;run<rounds;run++){const tracker=new HistoryTracker({strategy:'delta',trackingEnabled:()=>true,numberType:'integer',reset:()=>0});tracker.reset();const start=performance.now();for(let i=0;i<updatesPerRound;i++)tracker.update(i%2?-2:Number.MAX_SAFE_INTEGER);if(run>=warmup)integerSamples.push(performance.now()-start);assert.equal(tracker.value,-2);}
 console.log(JSON.stringify({node:process.version,baseline:'255bb601',...input,samples:rounds-warmup,pythonTiming:'Historical Python 3.12.13 desktop capture; not a fresh runtime comparison or target-board acceptance',updates,snapshots,integerDelta:{node:summary(integerSamples),capturedPython:summary(reference.integerDelta)}},null,2));
}finally{rmSync(baseline,{force:true});}
