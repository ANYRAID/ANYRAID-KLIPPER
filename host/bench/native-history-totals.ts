import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
const dir=await mkdtemp(join(tmpdir(),'history-totals-bench-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'bench'});
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.floor(values.length*.95)]};};
try{
 const poll=async(jobs:number)=>{const times:number[]=[];for(let i=0;i<550;i++){const start=performance.now(),result=await journal.historyTotals();if(i>=50)times.push(performance.now()-start);assert.equal(result.job_totals.total_jobs,jobs);assert.equal(result.job_totals.total_filament_used,jobs*0.5);}return summary(times);};
 const empty=await poll(0),terminal:number[]=[];
 for(let i=0;i<2000;i++){const id='job'+i;await journal.reserve({version:1,requestId:id,fileId:'file',nozzle:0,bed:0});const start=performance.now();await journal.transition(id,1,'cancelled',{totalDuration:10,printDuration:8,filamentUsed:0.5});if(i>=100)terminal.push(performance.now()-start);}
 const populated=await poll(2000),transaction=summary(terminal);assert(populated.p95Ms<5);assert(transaction.p95Ms<5);
 const start=performance.now(),reset=await journal.historyResetTotals(),resetMs=performance.now()-start;assert.equal(reset.last_totals.total_jobs,2000);assert.equal((await journal.historyTotals()).job_totals.total_jobs,0);assert(await journal.get('job0'));
 console.log(JSON.stringify({node:process.version,jobs:2000,empty,populated,terminal:transaction,resetMs,maximumPollP95Ms:5,maximumTerminalP95Ms:5,scope:'Local worker IPC, durable terminal commits and cached totals reads; no per-move work or target hardware guarantee.'}));
}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
