import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
const dir=await mkdtemp(join(tmpdir(),'journal-scan-bench-')),journal=await PrintJournal.open({path:join(dir,'journal.db'),deviceId:'bench'}),count=2000;
try{
 for(let i=0;i<count;i++){const requestId='job'+String(i).padStart(5,'0');await journal.reserve({version:1,requestId,fileId:'file',nozzle:0,bed:0});await journal.transition(requestId,1,'cancelled',{totalDuration:1,printDuration:0,filamentUsed:0});}
 const samples:number[]=[],pageTimes:number[]=[];
 for(let run=0;run<14;run++){let after:string|undefined,seen=0;const start=performance.now();do{const begin=performance.now(),page=await journal.scan(after,100);if(run>=3)pageTimes.push(performance.now()-begin);for(const record of page.records){assert.equal(record.request.requestId,'job'+String(seen++).padStart(5,'0'));assert.equal(record.state,'cancelled');assert(record.timestamps!.endedAt!>=record.timestamps!.reservedAt!);assert.equal(record.statistics!.totalDuration,1);}after=page.nextAfter??undefined;}while(after);assert.equal(seen,count);if(run>=3)samples.push(performance.now()-start);}
 samples.sort((a,b)=>a-b);pageTimes.sort((a,b)=>a-b);const pageP95Ms=pageTimes[Math.floor(pageTimes.length*.95)];assert(pageP95Ms<25);
 console.log(JSON.stringify({node:process.version,records:count,pageSize:100,warmups:3,runs:11,fullScanMedianMs:samples[5],fullScanP95Ms:samples[10],pageP95Ms,maximumPageP95Ms:25,scope:'Bounded worker IPC and indexed lexical traversal, includes result validation. Same process host; no physical target storage or concurrent motion guarantee.'}));
}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
