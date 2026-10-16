import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {PrintJournal} from '../src/operations/print-journal.ts';
import {PrintController} from '../src/operations/print.ts';
import {NativeHistoryFields} from '../src/moonraker/native-history-fields.ts';
const bytes=await readFile(new URL('../contracts/native-history-controller-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'ff7f6c66fc5e19a266d63fb7fd27d8201a33e97117cd9607bffc3498f62351a6');
const reference=JSON.parse(bytes.toString());
const count=Number(process.argv.find(arg=>arg.startsWith('--fields='))?.split('=')[1]??0);assert([0,64].includes(count));
const samples:number[]=[],queries:number[]=[],root=await mkdtemp(join(tmpdir(),'native-controller-budget-'));
try{for(let run=0;run<9;run++){
 const journal=await PrintJournal.open({path:join(root,run+'.db'),deviceId:'budget'}),controller=new PrintController({async prepare(){},async start(){},async pause(){},async resume(){},async finish(){},async stop(){}},{maxNozzle:300,maxBed:120},{},{journal});
 const owner=new NativeHistoryFields(),fields=[];
 for(let i=0;i<count;i++)fields.push(owner.fields.register({provider:'budget',name:'f'+i,description:'budget',strategy:'accumulate',reportTotal:true,reportMaximum:true,precision:3}));owner.bind(controller);
 try{
  const begun=performance.now();for(let i=0;i<100;i++){
   const request={version:1 as const,requestId:'job'+i,fileId:'file',nozzle:0,bed:0};await controller.start(request);
   for(const field of fields)field.tracker.update(1.25);
   await controller.complete(request.requestId);controller.reset(request.requestId);
  }const elapsed=performance.now()-begun;
  const q=performance.now();for(let i=0;i<100;i++)assert.equal((await controller.requestRecord('job'+i))!.state,'completed');const queried=performance.now()-q;
  const totals=await journal.historyTotals();assert.equal(totals.job_totals.total_jobs,100);
  if(count){assert.equal((await journal.historyGet('1'))!.auxiliary!.data.length,count);assert.equal(totals.auxiliary_totals.length,count);for(const value of totals.auxiliary_totals){assert.equal(value.total,125);assert.equal(value.maximum,1.25);}}
  if(run>=2){samples.push(elapsed);queries.push(queried);}
 }finally{await controller.retire();await journal.close();}
}const median=(a:number[])=>a.toSorted((x,y)=>x-y)[3],writeMedian=median(samples),queryMedian=median(queries),ratio=writeMedian/reference.median,queryRatio=queryMedian/reference.queryMedian,passed=ratio<=reference.limit&&queryRatio<=reference.limit;
console.log(JSON.stringify({node:process.version,fields:count,jobs:100,warmup:2,runs:7,samples,queries,median:writeMedian,queryMedian,ratio,queryRatio,limit:reference.limit,passed,scope:reference.scope,stressScope:'64 providers update 1.25 per job through the actual controller gate; initial/final snapshots and 125 totals/1.25 maxima independently checked. No hardware, motion, target board or statistical speedup claim.'},null,2));assert(passed,'Native controller exceeds frozen write/read budget');
}finally{await rm(root,{recursive:true,force:true});}
