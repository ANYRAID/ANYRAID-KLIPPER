import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
const dir=await mkdtemp(join(tmpdir(),'history-events-bench-')),samples:number[][]=[[],[]],jobs=100;
try{
 for(let run=0;run<14;run++)for(const variant of run%2?[1,0]:[0,1]){
  const journal=await PrintJournal.open({path:join(dir,run+'-'+variant+'.db'),deviceId:'bench'});let events=0,elapsed=0;
  try{
   if(variant)journal.subscribeHistory(event=>{assert.equal(event.record.historyId,Math.ceil(++events/2).toString(16).toUpperCase().padStart(6,'0'));});
   for(let i=0;i<jobs;i++){const id='job'+i,start=performance.now();await journal.reserve({version:1,requestId:id,fileId:'file',nozzle:0,bed:0});await journal.transition(id,1,'cancelled',{totalDuration:10,printDuration:8,filamentUsed:1});elapsed+=performance.now()-start;}
   assert.equal(events,variant?jobs*2:0);assert.equal(journal.historyObserverErrors,0);assert.equal((await journal.historyTotals()).job_totals.total_jobs,jobs);if(run>=3)samples[variant].push(elapsed/jobs);
  }finally{await journal.close();}
 }
 const results=samples.map(v=>{v.sort((a,b)=>a-b);return {medianMs:v[5],p95Ms:v[10]};}),addedP95Ms=results[1].p95Ms-results[0].p95Ms;assert(addedP95Ms<2);console.log(JSON.stringify({node:process.version,jobs,warmups:3,runs:11,variants:['noObserver','oneObserver'],results,addedP95Ms,maximumAddedP95Ms:2,scope:'Per-job reserve and terminal durable transactions including event IPC, with/without one enqueue-only observer in current implementation; not before/after worker capture or network latency, no physical target guarantee.'}));
}finally{await rm(dir,{recursive:true,force:true});}
