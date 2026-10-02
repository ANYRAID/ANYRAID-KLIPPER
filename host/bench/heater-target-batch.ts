import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {AsyncPrinterHeaters} from '../src/thermal/async-heaters.ts';
import {AsyncHeaterRuntime} from '../src/thermal/async-runtime.ts';
import {BangBangControl} from '../src/thermal/control.ts';
const dir=mkdtempSync(join(tmpdir(),'heater-target-batch-'));
try{
 const source=execFileSync('git',['show','3d919171:host/src/thermal/async-heaters.ts'],{encoding:'utf8'}).replace(/from '([^']+)'/g,(_m,p:string)=>`from '${new URL(p,new URL('../src/thermal/async-heaters.ts',import.meta.url)).href}'`),path=join(dir,'baseline.ts');writeFileSync(path,source);
 const {AsyncPrinterHeaters:Before}=await import(pathToFileURL(path).href) as {AsyncPrinterHeaters:typeof AsyncPrinterHeaters};
 const samples:number[][]=[[],[],[]];
 for(let run=0;run<14;run++)for(const kind of run%2?[2,1,0]:[0,1,2]){
  const runtimes:AsyncHeaterRuntime[]=[];let barriers=0;const group=new (kind===0?Before:AsyncPrinterHeaters)(()=>{barriers++;});
  for(const name of ['nozzle','bed']){const runtime=new AsyncHeaterRuntime({minimum:0,maximum:300,minimumExtrude:170,smoothTime:1,maxPower:1,reportDelay:.3},new BangBangControl(1),{configuration:{cycleTime:.1,maximumDuration:3,initialPower:0,defaultPower:0},reset:async()=>{},setPWM:async()=>{},stop:async()=>{}},()=>({system:1,print:1}),{},()=>()=>{});group.register(name,runtime);runtimes.push(runtime);}
  await group.start();for(const runtime of runtimes)runtime.sample(1,25);const signal=new AbortController().signal,start=performance.now();
  for(let i=0;i<10000;i++){if(kind===2)await group.setTargets([{name:'nozzle',target:200},{name:'bed',target:60}],signal);else{await group.setTarget('nozzle',200,signal);await group.setTarget('bed',60,signal);}}
  const elapsed=performance.now()-start;assert.equal(barriers,kind===2?10000:20000);assert.equal(group.getTemperature('nozzle').target,200);assert.equal(group.getTemperature('bed').target,60);await group.shutdown();if(run>=3)samples[kind].push(elapsed);
 }
 const stats=samples.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};});console.log(JSON.stringify({node:process.version,pairs:10000,samples:11,variants:['previousSingle','currentSingle','currentBatch'],stats,scope:'Immediate motion barrier and heater outputs; command/control overhead only, not physical heating.'}));
 assert(stats[1].medianMs<=stats[0].medianMs*1.3+2,'Single heater target regression');assert(stats[2].medianMs<=stats[0].medianMs*1.3+2,'Batched heater target regression');
}finally{rmSync(dir,{recursive:true,force:true});}
