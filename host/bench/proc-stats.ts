import assert from 'node:assert/strict';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {ProcStats} from '../src/moonraker/proc-stats.ts';
const elapsed:number[]=[],queries:number[]=[],loop=monitorEventLoopDelay({resolution:1}),stats=new ProcStats({connections:()=>0,notify(){}});
loop.enable();
try{
 for(let i=0;i<42;i++){const start=performance.now();await stats.sample();const ms=performance.now()-start;if(i>=2)elapsed.push(ms);}
 const view=stats.snapshot() as any;assert.equal(view.moonraker_stats.length,30);assert(view.moonraker_stats.at(-1).memory>0);assert(view.system_memory.total>0);
 const samplingEventLoopMaxMs=loop.max/1e6;loop.disable();
 for(let run=0;run<9;run++){const start=performance.now();for(let i=0;i<10000;i++)stats.snapshot();if(run>=2)queries.push((performance.now()-start)*1000/10000);}
 elapsed.sort((a,b)=>a-b);queries.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,sampleCount:elapsed.length,sampleMedianMs:elapsed[20],sampleP95Ms:elapsed[37],snapshotMedianMicroseconds:queries[3],snapshotP95Microseconds:queries[6],samplingEventLoopMaxMs,scope:'Real local Linux asynchronous sampling and 30-entry cached queries; loop delay covers sampling only; query burst timing is measured separately. No Python, target board or concurrent printer comparison.'},null,2));
}finally{loop.disable();await stats.close();}
