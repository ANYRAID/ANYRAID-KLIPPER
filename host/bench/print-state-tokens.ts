import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
const directory=await mkdtemp(join(tmpdir(),'state-token-bench-')),times:Record<string,number[]>={baseline:[],controller:[],api:[]},cycles=10000;
try{
 let source=execFileSync('git',['show','28ba001c:host/src/operations/print.ts'],{encoding:'utf8'});
 for(const name of ['maintenance-gate','print-deadline'])source=source.replace(`'./${name}.ts'`,JSON.stringify(new URL(`../src/operations/${name}.ts`,import.meta.url).href));
 const path=join(directory,'baseline.ts');await writeFile(path,source);const Baseline=(await import(pathToFileURL(path).href)).PrintController as typeof PrintController;
 for(let round=0;round<9;round++)for(const mode of round%2?['api','controller','baseline']:['baseline','controller','api']){
  const journal=await PrintJournal.open({path:join(directory,`${round}-${mode}.db`),deviceId:'bench'}),gate=new MaintenanceGate();let pauses=0,resumes=0;
  const target:PrintDevice={async prepare(){},async start(){},async pause(){pauses++;},async resume(){resumes++;},async finish(){},async stop(){}};
  const Type=mode==='baseline'?Baseline:PrintController,controller=new Type(target,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=mode==='api'?new ProductPrintApi(controller,gate):undefined,context={transport:'http' as const,signal:new AbortController().signal,authorize:()=>{}};
  try{await controller.start({version:1,requestId:'job',fileId:'file',nozzle:200,bed:60});const start=performance.now();
   for(let i=0;i<cycles;i++){
    if(api)await api.call('pause',{request_id:'job',state_token:controller.stateToken},context);else await controller.pause();assert.equal(controller.state,'paused');
    if(api)await api.call('resume',{request_id:'job',state_token:controller.stateToken},context);else await controller.resume();assert.equal(controller.state,'printing');
   }
   if(round>=2)times[mode].push(performance.now()-start);assert.equal(pauses,cycles);assert.equal(resumes,cycles);
  }finally{if(api)await api.close();else await controller.cancel();await journal.close();}
 }
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,cycles,controls:cycles*2,warmup:2,samples:7,baselineCommit:'28ba001c',scope:'Pause/resume state transitions and native API token checks with device substitutes. Initial journal start and final cancellation excluded; no network, motion or physical pause latency.',baseline:stats(times.baseline),controller:stats(times.controller),api:stats(times.api)},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
