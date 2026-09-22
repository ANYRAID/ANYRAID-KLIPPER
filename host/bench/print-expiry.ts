import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
const directory=await mkdtemp(join(tmpdir(),'print-expiry-bench-')),times:Record<string,number[]>={baseline:[],legacy:[],expiry:[]},jobs=2000;
try{
 let source=execFileSync('git',['show','ada77c0a:host/src/operations/print.ts'],{encoding:'utf8'});
 for(const name of ['maintenance-gate','print-deadline'])source=source.replace(`'./${name}.ts'`,JSON.stringify(new URL(`../src/operations/${name}.ts`,import.meta.url).href));
 const path=join(directory,'baseline.ts');await writeFile(path,source);const Baseline=(await import(pathToFileURL(path).href)).PrintController as typeof PrintController;
 for(let round=0;round<9;round++)for(const mode of round%2?['expiry','legacy','baseline']:['baseline','legacy','expiry']){
  let effects=0;const device:PrintDevice={async prepare(){effects++;},async start(){effects++;},async pause(){},async resume(){},async finish(){},async stop(){effects++;}},Type=mode==='baseline'?Baseline:PrintController,controller=new Type(device,{maxNozzle:300,maxBed:120},{},{maxRememberedRequests:jobs});
  const requests=Array.from({length:jobs},(_,i)=>({version:1 as const,requestId:'job'+i,fileId:'file',nozzle:200,bed:60,...mode==='expiry'?{expiresAt:Date.now()+3600000}:{}}));
  const start=performance.now();for(const request of requests){await controller.start(request);await controller.cancel();controller.reset(request.requestId);}const elapsed=performance.now()-start;
  assert.equal(effects,jobs*3);assert.equal(controller.state,'idle');if(round>=2)times[mode].push(elapsed);
 }
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,jobs,warmup:2,samples:7,baselineCommit:'ada77c0a',scope:'Start/cancel/reset lifecycle with in-memory device; baseline vs current legacy and expiring requests. No motion, thermal, storage or printing latency.',baseline:stats(times.baseline),legacy:stats(times.legacy),expiry:stats(times.expiry)},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
