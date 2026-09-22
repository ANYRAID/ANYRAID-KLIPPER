import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {PrintController,type PrintDevice} from '../src/operations/print.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {MaintenanceGate} from '../src/operations/maintenance-gate.ts';
import {ProductPrintApi} from '../src/moonraker/product-print-api.ts';
const directory=await mkdtemp(join(tmpdir(),'product-api-bench-')),times:Record<string,number[]>={direct:[],api:[]},queries:Record<string,number[]>={direct:[],api:[]},jobs=200;
try{
 for(let round=0;round<9;round++)for(const mode of round%2?['api','direct']:['direct','api']){
  const journal=await PrintJournal.open({path:join(directory,`${round}-${mode}.db`),deviceId:'bench'}),gate=new MaintenanceGate();let effects=0,elapsed=0;
  const target:PrintDevice={async prepare(){effects++;},async start(){effects++;},async pause(){},async resume(){},async finish(){},async stop(){}};
  const controller=new PrintController(target,{maxNozzle:300,maxBed:120},{},{journal,maintenanceGate:gate}),api=new ProductPrintApi(controller,gate),context={transport:'http' as const,signal:new AbortController().signal,authorize:()=>{}};
  try{for(let i=0;i<jobs;i++){
   const request={version:1 as const,requestId:'job'+i,fileId:'file',nozzle:200,bed:60,expiresAt:Date.now()+3600000},params={version:1,request_id:request.requestId,file_id:request.fileId,nozzle:request.nozzle,bed:request.bed,expires_at:request.expiresAt};
   const start=performance.now();if(mode==='direct')await controller.admit(request);else{const result=await api.call('start',params,context) as any;assert.equal(result.accepted,true);}elapsed+=performance.now()-start;
   await controller.start(request);await controller.complete(request.requestId);controller.reset(request.requestId);
  }assert.equal(effects,jobs*2);assert.equal((await journal.get('job199'))?.state,'completed');if(round>=2)times[mode].push(elapsed);const start=performance.now();for(let i=0;i<jobs;i++){const record=mode==='direct'?await controller.requestRecord('job'+i):(await api.call('status',{request_id:'job'+i},context) as any).record;assert.equal(record?.state,'completed');}if(round>=2)queries[mode].push(performance.now()-start);}
  finally{await api.close();await journal.close();}
 }
 const stats=(v:number[])=>{v.sort((a,b)=>a-b);return {medianMs:v[3],p95Ms:v[6]};};console.log(JSON.stringify({node:process.version,jobs,warmup:2,samples:7,scope:'Durable admission latency only, direct controller vs native API adapter; worker SQLite on local temp filesystem, device substitute, excludes authorization provider/network/heating/motion.',direct:stats(times.direct),api:stats(times.api),queryDirect:stats(queries.direct),queryApi:stats(queries.api)},null,2));
}finally{await rm(directory,{recursive:true,force:true});}
