import {performance} from 'node:perf_hooks';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {HistoryTracker,historyStrategies} from '../src/moonraker/history-tracker.ts';
import {historyTrackerOracle} from '../test/helpers/history-tracker-oracle.ts';
const count=100000;
const python=spawnSync('python3',['-c',historyTrackerOracle()+`
results={}
for name,cls in classes.items():
 samples=[]
 for run in range(13):
  h=History();h.active=True;FieldTracker.class_init(h)
  t=cls(exclude_paused=True);t.reset()
  start=time.perf_counter()
  for i in range(${count}):
   h.paused=i%10==0
   t.update((i%128)/8)
  elapsed=(time.perf_counter()-start)*1000
  if run>=2:samples.append(elapsed)
 results[name]=dict(samples=samples,value=t.get_tracked_value())
print(json.dumps(results))
`],{encoding:'utf8',timeout:120000});assert.equal(python.status,0,python.stderr);const reference=JSON.parse(python.stdout);
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};};
const results=[];
for(const strategy of historyStrategies){
 const samples:number[]=[];
 for(let run=0;run<13;run++){
  let paused=false;const tracker=new HistoryTracker({strategy,excludePaused:true,trackingEnabled:exclude=>!(exclude&&paused)});tracker.reset();
  const start=performance.now();for(let i=0;i<count;i++){paused=i%10===0;tracker.update((i%128)/8);}const elapsed=performance.now()-start;
  assert.deepEqual(tracker.value,reference[strategy].value);if(run>=2)samples.push(elapsed);
 }
 results.push({strategy,node:summary(samples),python:summary(reference[strategy].samples)});
}
console.log(JSON.stringify({node:process.version,count,warmup:2,samples:11,scope:'synchronous field updates, no persistence or hardware',results},null,2));
