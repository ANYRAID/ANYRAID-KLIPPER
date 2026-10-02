import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {GCodeDispatch} from '../src/gcode/dispatch.ts';
import {nativeCommandHelp} from '../src/gcode/command-help.ts';
const dispatch=new GCodeDispatch({output(){},shutdown(){}}),names=Object.keys(nativeCommandHelp),runs=11,warmups=2,queries=100000,samples:number[]=[];
for(const name of names)dispatch.register(name,()=>{});
for(let run=0;run<runs+warmups;run++){
 const start=performance.now();for(let i=0;i<queries;i++)assert.equal(Object.keys(dispatch.commandHelp()).length,names.length);const elapsed=performance.now()-start;
 if(run>=warmups)samples.push(elapsed);
}
samples.sort((a,b)=>a-b);
console.log(JSON.stringify({node:process.version,commands:names.length,runs,warmups,queriesPerRun:queries,medianMicrosecondsPerQuery:samples[Math.floor(runs/2)]*1000/queries,p95MicrosecondsPerQuery:samples[Math.ceil(runs*.95)-1]*1000/queries,scope:'In-process help dictionary snapshot plus key-count validation; descriptions resolved only during registration. No transport, Python or target-board comparison.'},null,2));
