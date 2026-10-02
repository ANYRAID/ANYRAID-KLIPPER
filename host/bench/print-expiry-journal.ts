import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
const dir=await mkdtemp(join(tmpdir(),'expiry-journal-bench-')),times:Record<string,number[]>={legacy:[],expiry:[]},jobs=200;let info;
try{
 for(let round=0;round<9;round++)for(const mode of round%2?['expiry','legacy']:['legacy','expiry']){
  const journal=await PrintJournal.open({path:join(dir,`${round}-${mode}.db`),deviceId:'bench'});info=journal.info;let effects=0;
  const target:PrintDevice={async prepare(){effects++;},async start(){effects++;},async pause(){},async resume(){},async finish(){effects++;},async stop(){}};
  const controller=new PrintController(target,{maxNozzle:300,maxBed:120},{},{journal}),expiresAt=Date.now()+3600000;
  try{const start=performance.now();for(let i=0;i<jobs;i++){const request={version:1 as const,requestId:'job'+i,fileId:'file',nozzle:200,bed:60,...mode==='expiry'?{expiresAt}:{}};await controller.start(request);await controller.complete(request.requestId);controller.reset(request.requestId);}
   const elapsed=performance.now()-start;assert.equal(effects,jobs*3);assert.equal(controller.state,'idle');const last=await journal.get('job199');assert.equal(last?.state,'completed');assert.equal(last.request.expiresAt,mode==='expiry'?expiresAt:undefined);if(round>=2)times[mode].push(elapsed);
  }finally{await journal.close();}
 }
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,jobs,warmup:2,samples:7,info,scope:'Worker SQLite durable reservation/start/completion with device substitutes on local temporary filesystem; no target flash or printing.',legacy:stats(times.legacy),expiry:stats(times.expiry)},null,2));
}finally{await rm(dir,{recursive:true,force:true});}
