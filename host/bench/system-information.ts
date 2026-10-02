import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {SystemInformation} from '../src/moonraker/system-information.ts';
const samples:number[]=[],queries:number[]=[];
for(let i=0;i<9;i++){const info=new SystemInformation();try{const start=performance.now();await info.refresh();const ms=performance.now()-start;assert.equal((info.snapshot() as any).system_info.runtime.name,'node');const begin=performance.now();for(let j=0;j<10000;j++)info.snapshot();if(i>=2){samples.push(ms);queries.push((performance.now()-begin)*1000/10000);}}finally{await info.close();}}
samples.sort((a,b)=>a-b);queries.sort((a,b)=>a-b);console.log(JSON.stringify({node:process.version,runs:7,warmups:2,refreshMedianMs:samples[3],refreshP95Ms:samples[6],snapshotMedianMicroseconds:queries[3],snapshotP95Microseconds:queries[6],scope:'Real local Linux metadata and optional ip/systemd-detect-virt commands; cached snapshot cloning. No Python, target-board or physical printer comparison.'},null,2));
