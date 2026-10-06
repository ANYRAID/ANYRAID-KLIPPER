import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {HistoryTracker,historyStrategies} from '../src/moonraker/history-tracker.ts';
import {historyBenchmarkReference} from '../test/helpers/history-reference.ts';
const count=100000,runs=13,warmup=2,pauseEvery=10,modulus=128,divisor=8;
const historical=historyBenchmarkReference<Record<string,{samples:number[];value:unknown}>>('history-tracker-benchmark',JSON.stringify({strategies:historyStrategies,count,runs,warmup,pauseEvery,modulus,divisor})),reference=historical.result;
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};};
const results=[];
for(const strategy of historyStrategies){
 const samples:number[]=[];
 for(let run=0;run<runs;run++){
  let paused=false;const tracker=new HistoryTracker({strategy,excludePaused:true,trackingEnabled:exclude=>!(exclude&&paused)});tracker.reset();
  const start=performance.now();for(let i=0;i<count;i++){paused=i%pauseEvery===0;tracker.update((i%modulus)/divisor);}const elapsed=performance.now()-start;
  assert.deepEqual(tracker.value,reference[strategy].value);if(run>=warmup)samples.push(elapsed);
 }
 results.push({strategy,node:summary(samples),pythonHistorical:summary(reference[strategy].samples)});
}
console.log(JSON.stringify({node:process.version,count,warmup,samples:runs-warmup,capturedAt:historical.capturedAt,referenceRuntime:historical.runtime,scope:'synchronous field updates, no persistence or hardware; Node executes today, CPython samples are historical',results},null,2));
