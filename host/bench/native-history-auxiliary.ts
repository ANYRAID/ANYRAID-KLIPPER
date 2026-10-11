import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {verifyJournalRows} from './helpers/journal-rows.ts';
import {PrintJournal} from '../src/operations/print-journal.ts';
import type {HistoryAuxiliarySnapshot} from '../src/moonraker/history-repository.ts';
const bytes=await readFile(new URL('../contracts/native-history-auxiliary-reference.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'711d4c3bc02e59f812fde972d4f0015affb095d0a6ae70e880fa7defbe23861b');
const reference=JSON.parse(bytes.toString()),fields=Number(process.argv.find(x=>x.startsWith('--fields='))?.split('=')[1]??0);assert([0,4,64].includes(fields));
const snapshot=():HistoryAuxiliarySnapshot=>({data:Array.from({length:fields},(_,i)=>({provider:'sensor room',name:'field'+i,value:1.25})),totals:Array.from({length:fields},(_,i)=>({provider:'sensor room',field:'field'+i,value:1.25,report_total:true,report_maximum:true,precision:2}))});
const root=await mkdtemp(join(tmpdir(),'journal-auxiliary-candidate-')),samples:number[]=[],starts:number[]=[],queries:number[]=[],details:number[]=[];
try{for(let run=0;run<9;run++){
 const path=join(root,run+'.db'),start=performance.now(),journal=await PrintJournal.open({path,deviceId:'budget'}),opened=performance.now()-start;
 try{const begun=performance.now();for(let i=0;i<100;i++){const request={version:1 as const,requestId:'job'+i,fileId:'file',nozzle:0,bed:0};assert((await journal.reserve(request,fields?snapshot():undefined)).created);await journal.transition(request.requestId,1,'started');const record=await journal.transition(request.requestId,2,'completed',{totalDuration:2,printDuration:1,filamentUsed:2.675},fields?snapshot():undefined);if(fields)assert.equal(record.auxiliary?.data.length,fields);}const written=performance.now()-begun;
 const q=performance.now();for(let i=0;i<100;i++)assert.equal((await journal.get('job'+i))!.state,'completed');const queried=performance.now()-q,totals=await journal.historyTotals();assert.equal(totals.job_totals.total_jobs,100);assert.equal(totals.auxiliary_totals.length,fields);for(const total of totals.auxiliary_totals){assert.equal(total.total,125);assert.equal(total.maximum,1.25);}
 const detailStart=performance.now();if(fields)for(let i=0;i<100;i++)assert.equal((await journal.historyGet((i+1).toString(16)))!.auxiliary?.data.length,fields);const detailed=performance.now()-detailStart;
 if(run>=2){samples.push(written);starts.push(opened);queries.push(queried);if(fields)details.push(detailed);}
 }finally{await journal.close();}
 verifyJournalRows(path,100,0,0);
}
 const median=(a:number[])=>a.toSorted((x,y)=>x-y)[3],ratio=median(samples)/reference.median,startupRatio=median(starts)/reference.startupMedian,queryRatio=median(queries)/reference.queryMedian,passed=ratio<=reference.limit&&startupRatio<=reference.limit&&queryRatio<=reference.limit;
 console.log(JSON.stringify({node:process.version,fields,jobs:100,warmup:2,runs:7,samples,starts,queries,details,median:median(samples),startupMedian:median(starts),queryMedian:median(queries),detailMedian:fields?median(details):null,ratio,startupRatio,queryRatio,limit:reference.limit,passed,scope:reference.scope,auxiliaryScope:'0/4/64 provider fields are captured with initial and final snapshots and counted atomically. All 100 ordinary request reads use the original metadata scope; 100 complete history detail reads additionally validate every field and are timed separately without an equivalence claim to the empty original payload. Prepared desktop only, not motion or board.'},null,2));assert(passed,'Native journal exceeds frozen startup/write/read budget');
}finally{await rm(root,{recursive:true,force:true});}
