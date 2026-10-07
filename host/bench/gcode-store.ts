import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {GcodeStore} from '../src/moonraker/gcode-store.ts';
import {stateReference,stateReferenceIdentity} from '../test/helpers/moonraker-state-reference.ts';
const count=100000,messages=['G1 X1 Y2 E0.1\nG1 X2 Y3 E0.2','ok T:210.25 B:60.0',' \n','// 中文响应'];
const samples:number[]=[],queries:number[]=[];
for(let run=0;run<13;run++){
 const store=new GcodeStore(1000,8*1024*1024,()=>100);let start=performance.now();
 for(let i=0;i<count;i++)store.record(messages[i%4],i%2?'response':'command');
 const elapsed=performance.now()-start;assert.equal(store.status.records,1000);
 start=performance.now();for(let i=0;i<10000;i++)assert.equal(store.snapshot(20).gcode_store.length,20);const queryMs=performance.now()-start;
 if(run>=2){samples.push(elapsed);queries.push(queryMs);}
}
const python=stateReference<number[]>('gcode-bench-0',JSON.stringify(messages),count,samples.length);
const rawAppendSamples=[...samples],rawQuerySamples=[...queries];
function stats(values:number[]){values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.ceil(values.length*.95)-1]};}
console.log(JSON.stringify({rawAppendSamples,rawQuerySamples,reference:stateReferenceIdentity,node:process.version,recordsPerRun:count,retained:1000,clock:'fixed on both sides',nodeAppend:stats(samples),historicalPythonAppend:stats(python),nodeTail20Queries10000:stats(queries),scope:'in-process history only; excludes transport, GC tail latency and hardware'},null,2));
