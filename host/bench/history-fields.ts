import {performance} from 'node:perf_hooks';
import {spawnSync,execFileSync} from 'node:child_process';
import {writeFileSync,rmSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {HistoryFields} from '../src/moonraker/history-fields.ts';
import {HistoryTracker,historyStrategies} from '../src/moonraker/history-tracker.ts';
import {historyFieldOracle} from '../test/helpers/history-field-oracle.ts';
const summary=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[Math.floor(v.length/2)],p95Ms:v[Math.ceil(v.length*.95)-1]};};
const baseline=new URL('../node_modules/.cache/history-tracker-fields-baseline-'+process.pid+'.mjs',import.meta.url);
try{
 const source=execFileSync('git',['show','255bb601:host/src/moonraker/history-tracker.ts'],{cwd:fileURLToPath(new URL('../../',import.meta.url)),encoding:'utf8'});writeFileSync(baseline,stripTypeScriptTypes(source).replace(/from '(\.\/[^']+)'/g,(_all,path)=>'from '+JSON.stringify(new URL(path,new URL('../src/moonraker/history-tracker.ts',import.meta.url)).href)));
 const Original=(await import(baseline.href)).HistoryTracker,updates=[];
 for(const strategy of historyStrategies){let expected:unknown;const samples:Record<string,number[]>={previous:[],current:[]};for(let run=0;run<9;run++)for(const mode of run%2?['current','previous']:['previous','current']){let paused=false;const Tracker=mode==='current'?HistoryTracker:Original,t=new Tracker({strategy,excludePaused:true,trackingEnabled:(exclude:boolean)=>!(exclude&&paused)});t.reset();const start=performance.now();for(let i=0;i<100000;i++){paused=i%10===0;t.update((i%128)/8);}if(run>=2)samples[mode].push(performance.now()-start);if(expected===undefined)expected=t.value;else assert.deepEqual(t.value,expected);}updates.push({strategy,previous:summary(samples.previous),current:summary(samples.current)});}
 const child=spawnSync('python3',['-c',historyFieldOracle()+`
h=History();h.active=True;FieldTracker.class_init(h)
fields=[HistoryFieldData(str(i),'sensor','Reading','basic',units='J',report_total=True,report_maximum=True,precision=2) for i in range(16)]
results={}
for mode in ['fixed','changing']:
 samples=[]
 for run in range(9):
  for field in fields:field.tracker.update(2.675)
  start=time.perf_counter()
  for i in range(1000):
   if mode=='changing':
    for field in fields:field.tracker.update(i/8)
   result=dict(data=[f.as_dict() for f in fields],totals=[dict(provider='sensor',field=f.name,value=f.tracker.get_tracked_value(),report_total=True,report_maximum=True,precision=2) for f in fields])
   encoded=json.dumps(result,separators=(',',':'))
  if run>=2:samples.append((time.perf_counter()-start)*1000)
 results[mode]=dict(samples=samples,result=result)
samples=[]
for run in range(9):
 tracker=DeltaTracker(reset_callback=lambda:0);tracker.reset()
 start=time.perf_counter()
 for i in range(100000):tracker.update(-2 if i%2 else 9007199254740991)
 if run>=2:samples.append((time.perf_counter()-start)*1000)
 assert tracker.get_tracked_value()==-2
results['integerDelta']=samples
print(json.dumps(results))`],{encoding:'utf8',timeout:120000});assert.equal(child.status,0,child.stderr);const reference=JSON.parse(child.stdout);
 const snapshots=[];
 for(const mode of ['fixed','changing']){const fields=new HistoryFields(()=>true),registered=Array.from({length:16},(_,i)=>fields.register({provider:'sensor',name:String(i),description:'Reading',strategy:'basic',units:'J',reportTotal:true,reportMaximum:true,precision:2}));const times=[];for(let run=0;run<9;run++){for(const field of registered)field.tracker.update(2.675);const start=performance.now();let result;for(let i=0;i<1000;i++){if(mode==='changing')for(const field of registered)field.tracker.update(i/8);result=fields.snapshot();JSON.stringify(result);}if(run>=2)times.push(performance.now()-start);assert.deepEqual(result,reference[mode].result);}snapshots.push({mode,node:summary(times),python:summary(reference[mode].samples)});}
 const integerSamples=[];for(let run=0;run<9;run++){const tracker=new HistoryTracker({strategy:'delta',trackingEnabled:()=>true,numberType:'integer',reset:()=>0});tracker.reset();const start=performance.now();for(let i=0;i<100000;i++)tracker.update(i%2?-2:Number.MAX_SAFE_INTEGER);if(run>=2)integerSamples.push(performance.now()-start);assert.equal(tracker.value,-2);}
 console.log(JSON.stringify({node:process.version,baseline:'255bb601',updatesPerRound:100000,snapshotsPerRound:1000,fields:16,warmup:2,samples:7,updates,snapshots,integerDelta:{node:summary(integerSamples),python:summary(reference.integerDelta)}},null,2));
}finally{rmSync(baseline,{force:true});}
