import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
const directory=await mkdtemp(join(tmpdir(),'print-stream-bench-')),cycles=10000;
const times:Record<string,number[]>={baseline:[],unobserved:[],draining:[],stalled:[]};
try{
 let source=execFileSync('git',['show','4b6df516:host/src/operations/print.ts'],{encoding:'utf8'});
 for(const name of ['maintenance-gate','print-deadline'])source=source.replace(`'./${name}.ts'`,JSON.stringify(new URL(`../src/operations/${name}.ts`,import.meta.url).href));
 const path=join(directory,'baseline.ts');await writeFile(path,source);const Baseline=(await import(pathToFileURL(path).href)).PrintController as typeof PrintController;
 for(let run=0;run<9;run++)for(const mode of run%2?Object.keys(times).reverse():Object.keys(times)){
  let pauses=0,resumes=0,changes=0;
  const target:PrintDevice={async prepare(){},async start(){},async pause(){pauses++;},async resume(){resumes++;},async finish(){},async stop(){}};
  const controller=new (mode==='baseline'?Baseline:PrintController)(target,{maxNozzle:300,maxBed:120});
  await controller.start({version:1,requestId:'job',fileId:'file',nozzle:0,bed:0});
  const abort=new AbortController(),stream=['draining','stalled'].includes(mode)?controller.watchState(abort.signal):undefined;
  const consumer=mode==='draining'?(async()=>{for await(const change of stream!){assert.ok(change.stateToken);changes++;}})():undefined;
  const start=performance.now();for(let i=0;i<cycles;i++){await controller.pause();await controller.resume();}
  if(run>=2)times[mode].push(performance.now()-start);
  assert.equal(pauses,cycles);assert.equal(resumes,cycles);
  if(mode==='stalled')assert.deepEqual((await stream!.next()).value,{state:'printing',stateToken:controller.stateToken});
  abort.abort();await consumer;if(mode==='draining')assert.ok(changes>=cycles);
  await controller.cancel();
 }
 const stats=(samples:number[])=>{samples.sort((a,b)=>a-b);return {medianMs:samples[3],p95Ms:samples[6]};};
 console.log(JSON.stringify({node:process.version,baseline:'4b6df516',cycles,controls:cycles*2,warmups:2,runs:7,results:Object.fromEntries(Object.entries(times).map(([name,samples])=>[name,stats(samples)])),scope:'Mock-device pause/resume lifecycle throughput with no observer, a draining observer, or a reader stalled for all 40000 transitions. No journal/network/hardware latency. Slow-reader state checked against current token after timing.'},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
