import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PrintJournal} from '../src/operations/print-journal.ts';
const dir=await mkdtemp(join(tmpdir(),'history-delete-bench-')),journal=await PrintJournal.open({path:join(dir,'jobs.db'),deviceId:'bench'}),count=2000;
const summary=(values:number[])=>{values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(values.length/2)],p95Ms:values[Math.floor(values.length*.95)]};};
try{
 for(let i=0;i<count;i++){await journal.reserve({version:1,requestId:'job'+i,fileId:'file',nozzle:0,bed:0});await journal.transition('job'+i,1,'cancelled');}
 const query=async(firstId:number)=>{const times:number[]=[];for(let i=0;i<120;i++){const start=performance.now(),records=await journal.historyList({order:'asc',limit:50});if(i>=20)times.push(performance.now()-start);assert.equal(records.length,50);assert.equal(BigInt('0x'+records[0].historyId),BigInt(firstId));}return summary(times);};
 await assert.rejects(journal.historyDelete('',true),/bounded/);assert(await journal.historyGet('1'));assert(await journal.historyGet('7D0'));
 const before=await query(1),deletionTimes:number[]=[];
 for(let i=1;i<=1900;i++){const start=performance.now();await journal.historyDelete(i.toString(16));if(i>100)deletionTimes.push(performance.now()-start);}
 const after=await query(1901),deletion=summary(deletionTimes);assert(after.p95Ms<25);assert(deletion.p95Ms<5);assert((await journal.get('job0'))!==null);assert.equal(await journal.historyGet('1'),null);
 let seen=0,cursor:string|undefined;do{const page=await journal.scan(cursor,256);seen+=page.records.length;cursor=page.nextAfter??undefined;}while(cursor);assert.equal(seen,count);
 const start=performance.now(),all=await journal.historyDelete('',true),deleteRemainingMs=performance.now()-start;assert.equal(all.deleted_jobs.length,100);assert.deepEqual(await journal.historyList(),[]);
 console.log(JSON.stringify({node:process.version,records:count,hidden:1900,queryPage:50,before,after,deletion,deleteRemainingMs,retainedRequestRecords:seen,maximumQueryP95Ms:25,maximumDeleteP95Ms:5,scope:'Worker reads before/after hiding 95 percent of records and acknowledged single-row hide transactions. No physical target guarantee or per-move work.'}));
}finally{await journal.close();await rm(dir,{recursive:true,force:true});}
